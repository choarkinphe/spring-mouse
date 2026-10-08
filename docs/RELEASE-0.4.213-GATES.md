# 0.4.213 发布门禁跟踪

## 当前结论

**未发布生产。** 用户于 2026-10-04 再次选择“补齐后发布”，没有批准偏离门禁。生产继续运行0.4.212。不能把基础健康、模拟global fetch成功或CI构建成功等同于R3发布批准。

候选：`4978d03bf47b4bd490535e3589f131bdaade1a90`，`choarkinphe/spring-mouse@sha256:c8ddb07f097656aab131084fbd6d9f7c39997ad914889e59c5b3459d012dd572`。

## 已验证

- 原候选镜像在独立Docker内部网络和隔离数据目录启动，无生产DB/env/Token挂载。
- 专用假上游以临时CA签名TLS提供两个千问域名；不是替换global fetch。
- 账号测试、模型同步、模型接口认证及两渠道三协议stream/nonstream的12组业务请求通过。
- 图片输入最小请求通过网关能力检查。
- 编译后的网关HTTP取消路径：响应头、首chunk、流中段、JSON body停滞均可取消并终止fake upstream工作；新健康请求随后成功。
- 后续加CONNECT计数后，真实代理穿透在编译后的网关HTTP路径观察到成功；没有把回退直连当代理成功。
- 本地Node22的真实网络取消矩阵通过：上述4阶段直连/代理、TLS握手、CONNECT等待、重试backoff、20并发取消、实际socket/handle/RSS采样及健康请求恢复。
- 新build-info与promotion验证、网络取消、千问、既有auto-ping/retry相关9文件56项测试通过（需新候选同镜像再跑）。
- 测试lockfile已在临时目录通过`npm ci`验证，可复现Vitest4.1.10；没有改动生产安装。
- CI自动覆盖`latest`已改为候选发布；正式promotion仍需要门禁证据、五分钟观察、两个不同负责人批准和额外明确发布授权。

## 缺项 / 阻断

| 门禁 | 状态 |
|---|---|
| CI、构建、运行Node主版本一致 | 原镜像CI24/运行22不一致；本地已改统一22，尚未新构建验证 |
| 固定lockfile且无npm install回退 | 本地已修改Dockerfile与CI；tests lockfile原被忽略，已取消忽略，尚未提交/重建 |
| build-info包含Node/Next/undici/lock SHA256 | 原镜像仅revision；新增脚本待新构建 |
| 原镜像raw执行器容器内取消矩阵 | **未通过**：runtime direct import动态undici不可用，代理stage未进入；不推断编译web路径失效；已补Dockerfile复制undici，需重建后验证 |
| 完整路由标签/回退、scheduler相关受控tick | 标签拒绝/允许、模型回退、网关并发取消已增加并跑通；千问无auto-ping handler，需记录不适用依据（quotaAutoPing仅claude/codex），原有handler回归仍需复核 |
| 专用真实千问API/TokenPlan预发布账号 | 尚未提供；不读取生产用户Key替代 |
| 真实代理路径及最小额度上游请求 | 待专用凭据与新候选 |
| 同候选五分钟观察、旧digest回滚演练 | 尚未完成 |
| 代码所有者、发布负责人两人批准 | 尚未收到 |

## 本地补齐设施（尚未发布）

- Dockerfile：严格lockfile/npm ci，构建指纹，同Node22，显式复制动态undici。
- Actions：Node22，测试依赖npm ci，取消相关门禁，同镜像TLS业务冒烟；只发布candidate/SHA，不自动覆盖latest/正式版本。
- `scripts/write-build-info.mjs`：revision/buildId/appVersion/Node/Next/undici/原lockfile hash。
- `scripts/release-container-smoke.mjs`：只接受不可变digest；独立internal network、随机假凭据、同镜像HTTP/辅助取消/隔离SQLite持久化检查，结束只清理拥有的资源。
- `scripts/promote-release.mjs`：验证门禁记录、五分钟观察、两个不同批准人、旧digest；默认只校验，`--publish`必须另外得到明确发布授权。

以上构建改动会产生**新候选**，不能补写成0.4.213旧镜像已满足指纹要求。提交/推送及生产更新仍需按批准边界执行。

## 安全输入与后续

通过安全本地凭据文件或获准的凭据通道配置专用API/TokenPlan Key及最小调用预算，不在聊天、报告或命令参数输出密钥。缺少凭据时先完成所有fake-upstream门禁，不声称完成真实验证。批准人身份与日期由真实负责人确认，不以另一AI会话代替。

生产模板支持`SPRING_MOUSE_IMAGE`，最终部署要持久固定候选digest；旧0.4.212镜像身份需发布时重新inspect取得RepoDigest。不得使用sqlite3旧`.backup`部署脚本、复制live SQLite主文件、删除生产卷或重启其他服务。
