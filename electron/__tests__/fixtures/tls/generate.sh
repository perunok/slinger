#!/bin/sh
# Regenerates the TLS test fixtures (run by hand, not by the tests; needs OpenSSL >= 3.4 for -not_before/-not_after).
# Everything here is a throwaway test identity: never trust these anywhere else.
set -eu
cd "$(dirname "$0")"
DAYS=36500
key() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1" 2>/dev/null; }
ext() { printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=%s\n' "$1" "$2" > ext.cnf; }

# Server CA and a server certificate for localhost / 127.0.0.1 signed by it.
key ca.key
openssl req -x509 -new -key ca.key -subj "/CN=Slinger Test CA" -days $DAYS -out ca.crt \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign
key server.key
openssl req -new -key server.key -subj "/CN=localhost" -out server.csr
ext "DNS:localhost,IP:127.0.0.1" serverAuth
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days $DAYS -extfile ext.cnf -out server.crt
# The same key, certificate valid only for another host name.
ext "DNS:other.invalid" serverAuth
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days $DAYS -extfile ext.cnf -out wronghost.crt
# The same key, expired (2001).
ext "DNS:localhost,IP:127.0.0.1" serverAuth
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -not_before 20000101000000Z -not_after 20010101000000Z \
  -extfile ext.cnf -out expired.crt
# Self-signed server certificate.
openssl req -x509 -new -key server.key -subj "/CN=localhost" -days $DAYS -out self-signed.crt \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

# Client CA and a client certificate (PEM + key, and PFX with passphrase "test-pass").
key client-ca.key
openssl req -x509 -new -key client-ca.key -subj "/CN=Slinger Test Client CA" -days $DAYS -out client-ca.crt \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign
key client.key
openssl req -new -key client.key -subj "/CN=slinger-test-client" -out client.csr
ext "DNS:slinger-test-client" clientAuth
openssl x509 -req -in client.csr -CA client-ca.crt -CAkey client-ca.key -CAcreateserial -days $DAYS -extfile ext.cnf -out client.crt
openssl pkcs12 -export -inkey client.key -in client.crt -passout pass:test-pass -out client.pfx

rm -f ext.cnf *.csr *.srl ca.key client-ca.key
