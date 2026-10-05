# 星载多硬件队列缓冲区同步复核器

审查员复核场景：星载图像处理器把**解码 / 校正 / 编码**提交分派到不同硬件队列，
需要复核同一缓冲区区间是否在**同步与所有权移交证据不足**时被另一队列读取。

零第三方依赖（仅 Node 20 内置模块），含操作页、HTTP API、规则测试与一次性验收服务。

## 容量与模型

| 对象 | 限制 |
|---|---|
| 队列 | ≤ 3 |
| 缓冲区 | ≤ 16，每个长度 ≤ 64 单元 |
| 提交 | ≤ 48 |

每个提交可 `wait` / `signal`（递增）时间线信号量，并按顺序包含
`read` / `write` / `release` / `acquire` 操作。

## 复核规则

1. **偏序**：同队列内严格按录入顺序；`wait(timeline, value)` 由按录入顺序
   累计覆盖该值的 signal 提交满足，建立 happens-before 边。
   - 无任何 signal 来源 / 总增量不足 → `UNMET_WAIT`（无满足来源的等待）
   - 等待边闭合为环 → `DEADLOCK`（给出死锁环提交序列）
2. **逐单元状态**：所有者、最新写版本、待获取移交（pending）、移交证据链。
3. **跨队列可见性**：只有 `release(属主) → 信号量先后关系 → acquire(读者)`
   证据完整匹配时才可见：
   - 无属主的读 → `OUT_OF_ORDER`（首个无序/未初始化读）
   - 非属主写、非属主 release、已移交后原属主再写 → `WRONG_OWNER`
   - 跨队列读无 acquire / 无 release / 跨队列缺信号量边 → `MISSING_ACQUIRE`
   - 凭旧移交版本读已更新单元 → `STALE_VERSION`
4. **输出**：通过时给出提交的一种拓扑可执行次序、各提交受影响区间、
   时间线终态与逐单元证据；拒绝时定位首个违规提交、队列与单元范围。

## HTTP

| 方法/路径 | 说明 |
|---|---|
| `GET /` | 操作页 |
| `GET /healthz` | 健康响应（含容量） |
| `GET /api/scenarios` | 两个内置规范场景 |
| `POST /api/verify` | 复核；成功 200，拒绝按类别 409/422 返回定位信息 |

## Compose

```bash
docker compose up --build -d          # 启动操作页 http://localhost:8080
docker compose run --rm verify        # 一次性验收; 退出码 0 = 通过
```

`verify` 服务等待 `web` 健康后执行 `scripts/acceptance.js`：
1. 规则代码测试（`node --test`，19 条）
2. 页面构建检查（页面内容标记 + 浏览器侧脚本语法与沙箱装载）
3. API/HTTP 冒烟：健康响应、“缺少获取的跨队列读取”被拒绝（HTTP 422
   `MISSING_ACQUIRE`，定位提交与区间）、“完整移交后读取”通过并呈现
   版本与移交证据，另含死锁环拒绝冒烟。

## 本地（无需 Docker）

```bash
npm start                 # http://localhost:8080
npm test                  # 规则测试
npm run verify            # 一次性验收(自行拉起服务)
```
