# 测试夹具

本目录保存离线测试所需的数据、公开测试证书和固定协议向量。均使用专用测试值，不能用于生产。测试命令与分层见 [项目 README](../../README.md#开发与验证)。

## 文件与来源

| 文件                                                     | 用途与来源                                                                                                              | 许可 / 使用说明                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [vmess-vectors.json](vmess-vectors.json)                 | 由 [scripts/vmess-oracle.go](../../scripts/vmess-oracle.go) 使用 Go 标准库独立生成的 AEAD / legacy 请求及响应长度向量。 | V2Fly 参考许可见 [V2RAY-LICENSE](V2RAY-LICENSE)。 |
| [tls-cert.pem](tls-cert.pem)、[tls-key.pem](tls-key.pem) | 专用 localhost 测试证书及公开私钥；测试进程单独信任证书，不关闭证书验证。                                               | 不用于部署或真实身份认证。                        |

## VMess 向量

生成器注释标明 KDF 参考 V2Fly v4.28.2；应用协议实现与独立互通服务端固定为 v4.31.3，详见[协议说明](../../docs/implementation.md#协议细节与资源限制)。向量固定输入如下：

| 输入         | 值                                     |
| ------------ | -------------------------------------- |
| UUID         | `00112233-4455-4677-8899-aabbccddeeff` |
| Key          | `00..0f`                               |
| IV           | `10..1f`                               |
| Response     | `42`                                   |
| Time         | `1700000000`                           |
| Auth random  | `01020304`                             |
| Header nonce | `0102030405060708`                     |
| 目标         | `example.com:443`                      |

在仓库根目录重新生成，需要 Docker 和固定 Go 镜像：

```sh
docker run --rm -v "$PWD/scripts:/oracle:ro" -w /oracle \
  golang@sha256:5616dca835fa90ef13a843824ba58394dad356b7d56198fb7c93cbe76d7d67fe \
  go run vmess-oracle.go > tests/fixtures/vmess-vectors.json
```

生成器使用独立哈希工厂，兼容 Go 1.16 的 HMAC 实例唯一性要求。常规测试只读取 JSON，不执行 Go；重新生成后需检查差异并运行 `mise run test`。

## 其他加密向量与凭据

AES-GCM 空明文向量来自 NIST SP800-38D；EVP_BytesToKey MD5 值通过以下命令独立核对：

```sh
openssl enc -aes-256-cbc -P -md md5 -nosalt -pass pass:password
```

集成测试的 SS 密码与 VMess UUID 在临时目录随机生成，测试后删除，不提交到仓库。向量 UUID、公开 TLS 私钥等固定测试值不属于用户凭据。
