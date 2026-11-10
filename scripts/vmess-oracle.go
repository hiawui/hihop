// Test-only independent oracle using Go's standard crypto library.
// KDF follows V2Fly v4.28.2 aead/kdf.go (MIT; see tests/fixtures/V2RAY-LICENSE).
package main

import (
 "crypto/aes"
 "crypto/cipher"
 "crypto/hmac"
 "crypto/md5"
 "crypto/sha256"
 "encoding/binary"
 "encoding/hex"
 "encoding/json"
 "hash"
 "hash/crc32"
 "hash/fnv"
 "os"
)

func kdf(key []byte, path ...string) []byte {
 factory := func() hash.Hash { return hmac.New(sha256.New, []byte("VMess AEAD KDF")) }
 for _, p := range path { previous, salt := factory, p; factory = func() hash.Hash { return hmac.New(previous, []byte(salt)) } }
 h := factory()
 h.Write(key); return h.Sum(nil)
}
func seal(key, iv, data, aad []byte) []byte { block,_:=aes.NewCipher(key);g,_:=cipher.NewGCM(block);return g.Seal(nil,iv,data,aad) }
func b16(n int) []byte { b:=make([]byte,2);binary.BigEndian.PutUint16(b,uint16(n));return b }
func join(parts ...[]byte) []byte { var out []byte;for _,p:=range parts {out=append(out,p...)};return out }
func main() {
 uuid,_:=hex.DecodeString("00112233445546778899aabbccddeeff");key:=make([]byte,16);iv:=make([]byte,16)
 for i:=range key {key[i]=byte(i);iv[i]=byte(i+16)}
 command:=md5.Sum(join(uuid,[]byte("c48619fe-8f02-49e0-b9e9-edf763e17e21")))
 alter:=md5.Sum(join(uuid,[]byte("16167dc8-16b6-4e6d-b8bb-65dd68113a81")))
 body:=join([]byte{1},iv,key,[]byte{42,1,3,0,1},b16(443),[]byte{2,11},[]byte("example.com"))
 fn:=fnv.New32a();fn.Write(body);header:=join(body,fn.Sum(nil))
 time:=make([]byte,8);binary.BigEndian.PutUint64(time,1700000000)
 auth:=hmac.New(md5.New,alter[:]);auth.Write(time);legacyIV:=md5.Sum(join(time,time,time,time));block,_:=aes.NewCipher(command[:]);enc:=make([]byte,len(header));cipher.NewCFBEncrypter(block,legacyIV[:]).XORKeyStream(enc,header)
 id:=join(time,[]byte{1,2,3,4},make([]byte,4));binary.BigEndian.PutUint32(id[12:],crc32.ChecksumIEEE(id[:12]));idblock,_:=aes.NewCipher(kdf(command[:],"AES Auth ID Encryption")[:16]);encryptedID:=make([]byte,16);idblock.Encrypt(encryptedID,id)
 nonce:=[]byte{1,2,3,4,5,6,7,8};strID,strNonce:=string(encryptedID),string(nonce)
 length:=seal(kdf(command[:],"VMess Header AEAD Key_Length",strID,strNonce)[:16],kdf(command[:],"VMess Header AEAD Nonce_Length",strID,strNonce)[:12],b16(len(header)),encryptedID)
 payload:=seal(kdf(command[:],"VMess Header AEAD Key",strID,strNonce)[:16],kdf(command[:],"VMess Header AEAD Nonce",strID,strNonce)[:12],header,encryptedID)
 responseKey:=sha256.Sum256(key);responseIV:=sha256.Sum256(iv)
 respLength:=seal(kdf(responseKey[:16],"AEAD Resp Header Len Key")[:16],kdf(responseIV[:16],"AEAD Resp Header Len IV")[:12],b16(4),nil)
 out:=map[string]string{"kdf":hex.EncodeToString(kdf(key,"AEAD Resp Header Len Key")),"alterId":hex.EncodeToString(alter[:]),"legacy":hex.EncodeToString(join(auth.Sum(nil),enc)),"aead":hex.EncodeToString(join(encryptedID,length,nonce,payload)),"responseLength":hex.EncodeToString(respLength)}
 json.NewEncoder(os.Stdout).Encode(out)
}
