# 多协议集群服务器 · 四套实现总览

统一架构方案的四份可运行 Demo：**Java（SOFAJRaft）**、**Java（Aeron Cluster）**、**Go**、**Rust**。
四套共用**同一套帧格式、命令字、响应格式、模块划分**，因此可跨语言互通。

---

## 一、交付清单

| 项目 | 语言 | 共识实现 | 状态 |
|---|---|---|---|
| `multiprotocol-cluster.zip` | Java 11 | **SOFAJRaft** + Aeron Cluster（双模型） | 完整源码 |
| `multiprotocol-cluster-go.zip` | Go 1.21 | 内存 Raft（默认）/ dragonboat（可选） | 完整源码 |
| `multiprotocol-cluster-rust.zip` | Rust 1.70+ | 内存 Raft（零依赖） | 完整源码 |

### 模块对应关系

| 职责 | Java | Go | Rust |
|---|---|---|---|
| 帧格式 + 命令模型 | `mp-common` | `internal/mpcommon` | `mp-common` |
| 共识抽象 | `mp-consensus-api` | `internal/consensus` | `mp-consensus` |
| 共识实现 | `mp-consensus-jraft` / `-aeron` | 同包（mode 切换） | 同 crate |
| 多协议接入 | `mp-gateway` | `internal/gateway` | `mp-gateway` |
| 指标监控 | `mp-observability` | `internal/observability` | `mp-observability` |
| 启动器 | `mp-launcher` | `cmd/server` | `mp-server` |

---

## 二、协议支持矩阵

| 协议 | Java | Go | Rust | Node 参考 | 默认启用 | 说明 |
|---|:---:|:---:|:---:|:---:|:---:|---|
| **TCP** | ✅ | ✅ | ✅ | ✅ | ✅ | 流式，需处理粘包/半包 |
| **UDP** | ✅ | ✅ | ✅ | ✅ | ✅ | 数据报，天然分帧 |
| **KCP** | ✅ | ✅ | ✅ | ✅ | ✅ | 可靠 UDP（ARQ），零依赖自实现 |
| **CUSTOM** | ✅ | ✅ | ✅ | ✅ | ✅ | UDP 变体 + 可插拔 payload 变换 |
| **QUIC** | ✅ | ✅ | ✅ | ❌ | ❌ 可选 | 需外部库与 TLS 证书 |

**五种协议三版全部补齐**（Node 参考实现不含 QUIC）。
QUIC 默认关闭，通过构建开关隔离：

| 版本 | 启用方式 |
|---|---|
| Java | `mvn -Pquic clean package` |
| Go | `make build-quic`（`-tags quic`） |
| Rust | `cargo build --release --features quic` |


## 三、统一端口分配

| 协议 | 端口 | 用途 |
|---|---|---|
| TCP | `9101` | 可靠流式接入 |
| UDP | `9201` | 低延迟数据报 |
| CUSTOM | `9301` | 自定义协议（UDP 变体） |
| KCP | `9401` | 可靠 UDP |
| QUIC | `9501` | 可选，需构建开关 |
| metrics | `9091` | Prometheus `/metrics`、`/healthz` |

---

## 四、跨语言互通

四套实现共用同一帧格式，**任意服务端 + 任意客户端**可组合：

```
┌────────┬─────────┬───────┬──────┬──────┬────────┬─────────┬───────┐
│ magic  │ version │ flags │ cmd  │ seq  │ length │ payload │ crc32 │
│ 2B     │ 1B      │ 1B    │ 4B   │ 8B   │ 4B     │ N B     │ 4B    │
└────────┴─────────┴───────┴──────┴──────┴────────┴─────────┴───────┘
```

- `magic` = `0x4D50`（"MP"），**大端序**
- `crc32` 覆盖 `[offset 2, 2+18+len)`

### 已验证一致的部分

| 项 | 结果 |
|---|---|
| magic / 头长 20B / CRC 4B | ✅ 四版一致 |
| 命令字 1-6、响应码 0-3 | ✅ 四版一致 |
| 状态机命令类型码 1-4 | ✅ 四版一致 |
| **帧编码字节序列** | ✅ Node 生成 golden → Python 独立复刻 12/12 逐字节一致；Rust 硬编码向量 3/3 一致 |
| **CRC32** | ✅ 标准值 `crc32("123456789")=0xCBF43926` 锚定；Node zlib 与 Python zlib 双向校验 |
| **KCP 常量** | ✅ Node/Go/Rust/Java 四版 14 项全部一致 |
| **KCP 算法** | ✅ Python 独立复刻验证分片/重组/丢包重传/乱序 |

### 🟢 唯一真实运行的部分：`reference-impl/`

沙盒缺 Java/Go/Rust 工具链，那三版无法编译。
但附带的 **Node.js 参考实现可以真实运行**：

| 验证 | 结果 |
|---|---|
| 单元测试 | **23 项全通过** |
| 端到端（真实 loopback socket） | **15 项全通过** |
| 覆盖协议 | TCP / UDP / CUSTOM / KCP |

它证明协议设计自洽，并为三版提供黄金基准与 golden 向量测试。

### 命令字

| cmd | 名称 | 走共识 | 说明 |
|---|---|---|---|
| 1 | `PUT` | ✅ 写 | 仅 Leader 可写 |
| 2 | `GET` | ✅ 线性读 | 线性一致读 |
| 3 | `ROUTE_SET` | ✅ 写 | 设置 `shard → node` |
| 4 | `ROUTE_GET` | 本地读 | 读路由表 |
| 5 | `PING` | ❌ | 测纯接入层延迟 |
| 6 | `STATS` | ❌ | 节点状态 |

响应格式统一为 `OK|body` 或 `ERR|body`。

---

## 五、共识层对照

| 版本 | 生产方案 | Demo 默认 | 切换方式 |
|---|---|---|---|
| Java | SOFAJRaft / Aeron Cluster | — | `--mode jraft` / `--mode aeron` |
| Go | dragonboat | 内存 Raft | `go build -tags dragonboat` |
| Rust | openraft（可扩展） | 内存 Raft | 实现 `Consensus` trait |

三条硬约束（四版一致）：

1. **只有元数据上共识层**，业务数据流不进 Raft
2. **状态机 apply 必须幂等**（日志会被重放与重试）
3. **线性读不得返回旧值**

---

## 六、⚠️ 验证状态（重要）

**四套项目均未在真实环境中编译与运行验证。**

生成环境限制：

| 缺失 | 影响 |
|---|---|
| 无 `javac` / Maven | Java 版无法编译 |
| 无 Go 工具链 | Go 版无法 `go build` / `go test` |
| 无 Rust 工具链 | Rust 版无法 `cargo build` / `cargo test` |
| 外网不可达（Maven / crates.io / apt 均 403） | 无法安装任何工具链 |

**已完成的自检**（能做的都做了）：

- ✅ 各项目跨包/跨 crate 符号引用全部可解析
- ✅ 括号与泛型平衡、import 无冗余
- ✅ 帧编解码：Rust 手写 CRC32 与标准 IEEE 交叉验证一致
- ✅ 三版常量（magic/命令字/响应码/类型码）完全一致
- ✅ KCP 算法：Python 独立复刻验证分片、重组、丢包重传、乱序
- ✅ 内存 Raft 锁序复核（锁内快照 → 锁外通信 → 锁内更新）

**这些自检无法替代真实编译**。首次构建请按顺序排查：

```bash
# Java
mvn test              # 1. 先跑契约测试
./scripts/start-jraft.sh && ./scripts/test-tcp.sh

# Go
go vet ./...          # 1. 静态检查
make test             # 2. 契约自测（零依赖）
make build && ./scripts/e2e.sh

# Rust
cargo check           # 1. 最快暴露编译错误
cargo test -p mp-common -p mp-gateway   # 2. 含 KCP 单元测试
cargo build --release && ./scripts/e2e.sh
```

---

## 七、快速上手

### Go

```bash
cd multiprotocol-cluster-go
make build && ./scripts/start.sh
./bin/mp-client --proto tcp  --port 9101
./bin/mp-client --proto udp  --port 9201
./bin/mp-client --proto kcp  --port 9401
curl http://127.0.0.1:9091/metrics | grep ^mp_
./scripts/stop.sh
```

### Rust

```bash
cd multiprotocol-cluster-rust
cargo build --release && ./scripts/start.sh
./target/release/mp-server client --proto tcp --port 9101
./target/release/mp-server client --proto udp --port 9201
./target/release/mp-server client --proto kcp --port 9401
curl http://127.0.0.1:9091/metrics | grep ^mp_
./scripts/stop.sh
```

### Java（双模型）

```bash
cd multiprotocol-cluster
mvn clean package -DskipTests
./scripts/start-jraft.sh    # SOFAJRaft
./scripts/start-aeron.sh    # Aeron Cluster（需先放大 /dev/shm）
./scripts/test-tcp.sh
```

> Aeron 启动失败的头号原因是 `/dev/shm` 不足：
> `mount -o remount,size=1G /dev/shm`

---

## 八、监控指标

四版暴露同名指标，可直接用同一套 Prometheus + Grafana 面板：

| 指标 | 类型 | 说明 |
|---|---|---|
| `mp_requests_total` | Counter | 按协议/命令维度请求数 |
| `mp_request_duration` | Histogram | 请求耗时（12 个分桶） |
| `mp_consensus_propose_duration` | Histogram | 共识提交耗时 |
| `mp_consensus_propose_errors_total` | Counter | 共识写失败数 |
| `mp_connections_active` | Gauge | 活跃连接数 |
| `mp_uptime_seconds` | Gauge | 进程运行时长 |

---

## 九、已知待办与风险

- **QUIC 未验证**：三版均已实现，但需外部库（`netty-incubator-codec-quic` /
  `quic-go` / `quinn`），沙盒无法拉取依赖，**连编译验证都未做**。
  已知版本风险：quinn 0.10 与 0.11 的 `Endpoint::server` 签名不同；
  quic-go 与 netty-quic 的 API 在各版本间也有变动。
  启用前请对照各库官方 example 核对。

- **Aeron Cluster**：非原生 Multi-Raft，不支持分片扩展
- **dragonboat / openraft**：需联网拉取依赖，接口签名未经实机核对
- **跨进程部署**：Go/Rust 默认内存 Raft 为单进程多节点，跨进程需切生产级实现
