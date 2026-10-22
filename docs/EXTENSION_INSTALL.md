# 浏览器插件安装和验证

1. 从GitHub下载并解压完整仓库。
2. 在本机先启动 ERP http://127.0.0.1:8765，使用新创建的账号登录。
3. Edge输入 edge://extensions/，开启开发人员模式，点击加载解压缩的扩展。
4. 选择 extensions/wyerp-collector/ 目录（必须直接看到 manifest.json）。
5. 打开支持的1688或Ozon商品页，等待商品数据加载完毕并手动采集。
6. 在ERP的采集箱中逐项核查内容是否保存成功。
7. 侧栏和Seller统计仅在合法权限及站点兼容时使用；不属于保存商品的前提。

当前插件是自有代码社区版0.4.44，较旧，未在真实平台完成最新兼容回归；不含第三方私有接口和令牌模块。
更多细节参见 extensions/wyerp-collector/README.md。