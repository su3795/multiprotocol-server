# 多协议集群服务器 · 完整实现

四套独立实现（Java 双模型 / Go / Rust / Node 参考实现），支持五种网络协议，集群采用 Raft 共识，提供实时监控与性能监测。

---

## 协议支持矩阵

| 协议 | Java | Go | Rust | Node 参考 | 默认启用 |
|---|:---:|:---:|:---:|:---:|:---:|
| **TCP** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **UDP** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **KCP** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **CUSTOM** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **QUIC** | ✅ | ✅ | ✅ | ❌ | ❌ 可选 |

QUIC 默认关闭（需外部库 + TLS 证书），通过构建开关隔离：

| 版本 | 启用方式 |
|---|---|
| Java | `mvn -Pquic clean package` |
| Go | `make build-quic`（`-tags quic`） |
| Rust | `cargo build --release --features quic` |

---

## 最快验证（零依赖，只需 Node）

```bash
node demo.js test      # 自检 13 项（帧编解码 + KCP + CRC 标准值）
node demo.js e2e       # 端到端 15 项（真实 socket：TCP/UDP/KCP）
node demo.js server    # 启动服务端
node demo.js client --proto tcp --port 9101
```

实测（Node v20.19.5）：**13 通过 / 0 失败**，**15 通过 / 0 失败**。

`e2e` 在同一进程内启动服务端与客户端，通过真实 loopback socket 通信，
覆盖 TCP / UDP / KCP 各 5 个命令（PING / PUT / GET / ROUTE_SET / ROUTE_GET）。

---

## 目录结构

```
.
├── demo.js                  # 单文件最小可运行 Demo（零依赖）
├── docs/
│   ├── DEPLOYMENT.md        # 部署与启动说明（13 节）
│   ├── OVERVIEW.md          # 四套实现总览
│   └── QUICKSTART.txt       # 快速启动速查表
├── java/                    # Java 版（SOFAJRaft + Aeron Cluster 双模型）
├── go/                      # Go 版（默认零依赖）
├── rust/                    # Rust 版（默认零依赖）
└── reference-impl/          # Node.js 协议参考实现（可运行）
```

---

## 各版本启动

### Go 版（推荐先跑）

```bash
cd go
go vet ./...
make test
make build
./scripts/start.sh
./bin/mp-client --proto tcp --port 9101
./scripts/stop.sh
```

一条命令跑完整端到端：`make e2e`

### Rust 版

```bash
cd rust
cargo check
cargo test -p mp-common -p mp-gateway
cargo build --release
./scripts/start.sh
```

### Java 版（SOFAJRaft）

```bash
cd java
mvn clean package -DskipTests
./scripts/start-jraft.sh
./scripts/test-tcp.sh
```

### Java 版（Aeron Cluster）

```bash
cd java
mvn clean package -DskipTests
# 必须：放大共享内存（Aeron 启动失败的头号原因）
sudo mount -o remount,size=1G /dev/shm
./scripts/start-aeron.sh
```

### 容器编排（含 Prometheus + Grafana）

```bash
docker compose up -d
# Prometheus http://localhost:9090
# Grafana    http://localhost:3000 (admin/admin)
```

---

## 端口分配（四版统一）

| 协议 | 端口 |
|---|---|
| TCP | `9101` |
| UDP | `9201` |
| CUSTOM | `9301` |
| KCP | `9401` |
| QUIC | `9501`（可选） |
| metrics | `9091` |

---

## 技术选型

| 领域 | Java | Go | Rust |
|---|---|---|---|
| 网络 | Netty 4.1 | gnet / netpoll | Tokio |
| QUIC | netty-incubator-codec-quic | quic-go | quinn |
| KCP | kcp-java（自实现） | 自实现 | 自实现 |
| 共识 | SOFAJRaft / Aeron Cluster | dragonboat（可选） | openraft（可选） |
| 指标 | Micrometer | OTel | metrics + tracing |
| 剖析 | JFR + async-profiler | pprof | pprof-rs |

---

## 验证状态（务必阅读）

Java / Go / Rust 三版**未在真实环境编译运行过**（生成环境无对应工具链、无外网）。

已完成的自检：

| 检查项 | 结果 |
|---|---|
| 源文件括号平衡（状态机扫描） | ✅ |
| 跨包 / 跨 crate 符号可解析 | ✅ |
| 三版常量一致（magic / 命令字 / 响应码） | ✅ |
| KCP 常量四版 14 项一致 | ✅ |
| 帧编码 Node → Python 独立复刻 | ✅ 12/12 逐字节一致 |
| CRC32 标准值 `0xCBF43926` 锚定 | ✅ |

各协议可信度：

| 协议 | 可信度 |
|---|---|
| TCP / UDP | 🟢 高 |
| KCP / CUSTOM | 🟡 中高 |
| QUIC | 🔴 低（完全未验证） |

唯一真实运行并跑通的代码：`demo.js` 与 `reference-impl/`（Node.js）。

---

## 常见坑

| 现象 | 处理 |
|---|---|
| Aeron 启动失败 | `/dev/shm` 不足 → `mount -o remount,size=1G /dev/shm` |
| `EventCode` 找不到 | Aeron 部分版本改名为 `ClusterEvent` |
| `let else` 语法错误 | Rust < 1.65，升级到 1.70+ |
| `spawn_blocking` 不工作 | Tokio 未启用 `rt-multi-thread` |
| quinn 编译错误 | 0.10 与 0.11 的 `Endpoint::server` 签名不同 |
| KCP 一直超时 | 服务端 KCP 端口未起，看 `logs/server.log` |

更多见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 第 7 节。

---

## 跨语言互通

四套实现共用同一帧格式（`magic 0x4D50` 大端、20B 头、CRC32 IEEE 802.3），
任意服务端 + 任意客户端可组合。
