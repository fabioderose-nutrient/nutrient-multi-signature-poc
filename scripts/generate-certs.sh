#!/bin/sh
# Generates the demo certificates in ./certs (gitignored):
#
#   certs/ca.key, certs/ca.crt          demo root CA (10 years)
#   certs/<signer>.key, <signer>.crt    one RSA key and certificate per signer
#                                       (alice, bob, carol), issued by the CA
#   certs/trusted/demo-ca.pem           the CA certificate the viewer trusts
#                                       when it validates signatures
#
# The private keys stay on the server: the browser sends the data to sign to
# POST /api/users/:id/sign. These certificates are for local demos only.
# Run it once before `npm start`. Pass --force to replace existing certificates.
set -eu
cd "$(dirname "$0")/.."

SIGNERS="alice:Alice bob:Bob carol:Carol"
ORG="Nutrient Multi-Signature Demo"

if [ -f certs/ca.key ] && [ "${1:-}" != "--force" ]; then
  echo "certs/ already exists. Use --force to generate new certificates."
  exit 0
fi

rm -rf certs
mkdir -p certs/trusted
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Minimal OpenSSL configuration, so the script does not depend on the system one.
cat > "$tmp/openssl.cnf" <<CNF
[req]
distinguished_name = dn
prompt = no

[dn]
O = $ORG CA
CN = Nutrient Demo Root CA

[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash

[v3_signer]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, nonRepudiation
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid, issuer
CNF

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out certs/ca.key 2>/dev/null
openssl req -new -x509 -config "$tmp/openssl.cnf" -extensions v3_ca -key certs/ca.key \
  -sha256 -days 3650 -out certs/ca.crt
cp certs/ca.crt certs/trusted/demo-ca.pem

for entry in $SIGNERS; do
  id=${entry%%:*}
  name=${entry#*:}
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "certs/$id.key" 2>/dev/null
  openssl req -new -config "$tmp/openssl.cnf" -key "certs/$id.key" -subj "/O=$ORG/CN=$name" -out "$tmp/$id.csr"
  openssl x509 -req -in "$tmp/$id.csr" -CA certs/ca.crt -CAkey certs/ca.key \
    -CAcreateserial -CAserial "$tmp/ca.srl" -sha256 -days 1825 \
    -extfile "$tmp/openssl.cnf" -extensions v3_signer -out "certs/$id.crt" 2>/dev/null
done
chmod 600 certs/*.key

echo "Generated certs/ca.crt, certs/trusted/demo-ca.pem and a key and certificate for alice, bob and carol."
