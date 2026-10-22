# 部署准备（开发和测试用途）

1. 在隔离环境中安装 Node.js 20 或更高版本、PostgreSQL 和适用的系统工具。
2. 进入 erp/ 后运行 npm ci，不要把 node_modules 提交仓库。
3. 参考 erp/.env.example 和 erp/deploy/production.env.example 配置专用环境变量与 Secret。
4. 在新的空 PostgreSQL 数据库中依照 erp/db/README.md 检查和执行适用的迁移。
5. 仅在隔离测试环境运行 erp/start.ps1，默认本机端口通常为 8765。
6. 如需公网部署，先完成独立安全审查、功能验收、最小权限、HTTPS、备份和恢复演练。

重要：不得连接原开发者的业务数据。软件尚无零配置安装保证。
任何 Ozon API 接入都需要开发者自己的合法账号和授权。
已废止的无人值守订单自动同步、Seller/Cookie 自动同步和插件心跳方案不得恢复。
