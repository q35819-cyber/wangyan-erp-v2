# 网研 ERP：首次 admin 自动创建与密码交付

仅用于全新 Windows 电脑和全新本机 PostgreSQL 数据库。数据库须采用 wyerp_community_* 命名。严禁将本流程用于原有ERP业务数据库。

## 换 AI 会自动创建吗？

答：新版本的部署脚本可以自动创建，但另一个AI必须按照 AGENTS.md 和 docs/CONFIGURATION.md 的顺序主动执行一次；不会因为下载仓库或启动ERP就私自创建。

- 管理员用户名固定：admin（系统只允许一个系统管理员）。
- 默认执行 bootstrap-admin.ps1 时，自动使用安全随机数生成43字符独立密码，并在完成空库迁移后创建admin与系统管理租户。
- 没有通用初始密码，数据库只保存使用scrypt计算的密码哈希。
- 仅在新电脑数据目录外部的 secrets/initial-admin-password.txt 保存一次明文，权限仅供执行安装的本机用户与 SYSTEM。仓库中绝不保存它。
- 用户本人在本机查看密码文件；不要让AI把密码发送到聊天或者终端日志。
- 只有数据库 users、tenants、tenant_members 全为零，且全部迁移版本校验通过，才会创建；再次运行或者遇到已有账号时直接拒绝。
- 自动生成模式失败时清除本次临时密码文件，不修改现有用户。

## 无需人工输入密码的推荐命令

前提：已经按照 docs/CONFIGURATION.md 安装Node.js/PostgreSQL、创建了新的 wyerp_community_* 数据库并执行全部迁移。

在ERP子目录的PowerShell中执行：

    $root = Join-Path $env:LOCALAPPDATA 'WyerpCommunityFresh'
    .\scripts\bootstrap-admin.ps1 -DataRoot $root

成功时打印 admin 用户名和密码文件路径，但不打印密码。

由本机用户打开文件：

    notepad (Join-Path $root 'secrets\initial-admin-password.txt')

文件包含 username=admin 与 password=随机值。请用这个账号登录：

    http://127.0.0.1:8765

确认能登录且已经用密码管理器安全保存后，本机用户可清除一次性密码文件：

    Remove-Item -LiteralPath (Join-Path $root 'secrets\initial-admin-password.txt')

不要在用户尚未登录且未保存密码时提前删除文件。

## 需要手工设置密码时

    .\scripts\bootstrap-admin.ps1 -DataRoot $root -PromptForPassword

输入过程不回显，密码至少12位；此模式不会生成密码文件。两种模式都只能在全新空库第一次执行，不会重置已有管理员密码。

## 复测与验收的边界

通过：脚本PowerShell语法、随机密码长度和字符格式、私有文件ACL、模拟空库创建、重复创建拒绝、模拟非空库拒绝与失败后临时密码文件清理。所有模拟PG测试均未连接现有业务数据库。

未验证：另一台全新电脑上的真实PostgreSQL全部迁移、第一次admin网页登录、真实1688/Ozon采集入库。只有实际登录成功才能将管理员登录判为PASS。

先阅读 docs/CONFIGURATION.md 与 docs/DEPLOYMENT_STATUS.md。没有用户授予新机数据库管理员权限时，另一个AI不能假装已经安装或自动创建成功。