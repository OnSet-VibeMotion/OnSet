# macOS 发布签名与公证

`.github/workflows/release.yml` 在 macOS runner 上用 electron-builder 签名、公证并打包 arm64 / x64 DMG。两个架构的应用都必须通过签名完整性、Gatekeeper 与公证票据检查，才会上传安装包。Windows 仍独立构建未签名的 NSIS 安装程序。

## 一次性配置

需要有效的 Apple Developer Program 会员，以及 **Developer ID Application** 证书。这个证书用于 App Store 外分发；本仓库的 DMG 不需要 Developer ID Installer 证书。

1. 在 Mac 的「钥匙串访问」中创建证书签名请求（CSR）。
2. 在 Apple Developer 的 Certificates 页面创建 Developer ID Application 证书，上传 CSR，下载 `.cer`。
3. 在生成 CSR 的 Mac 上导入 `.cer`。在「我的证书」中确认该证书下有对应私钥，然后把证书与私钥一起导出为 `.p12`，设置非空导出密码。
4. 将 `.p12` 编码并复制到剪贴板：

   ```bash
   base64 -i ~/Downloads/developer-id.p12 | pbcopy
   ```

5. 在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 添加以下 repository secrets：

   | Secret | 值 |
   |---|---|
   | `MAC_CSC_LINK` | 上一步复制的 `.p12` Base64 内容 |
   | `MAC_CSC_KEY_PASSWORD` | 导出 `.p12` 时设置的密码 |
   | `APPLE_ID` | Apple 开发者账号邮箱 |
   | `APPLE_APP_SPECIFIC_PASSWORD` | Apple 账号管理页生成的 App 专用密码，不是登录密码 |
   | `APPLE_TEAM_ID` | Apple Developer 会员页面的 Team ID |

`.p12`、私钥和密码都不要放进仓库。electron-builder 在 runner 上自动创建临时钥匙串并导入证书，无需手工调用 `security import`。证书选择、签名与 Apple 公证由 electron-builder 完成，公证票据自动附到 `.app`。

## 验证与发布

先把配置提交到 GitHub，再到 **Actions → Release → Run workflow** 选择包含改动的分支进行验证。手动运行也要求签名凭据齐全，产物只保存在 Actions artifacts，不会创建 GitHub Release。

发布时推送 `v<版本>` tag，或发布对应 tag 的 GitHub Release。tag 必须包含这次工作流和打包配置的改动；重跑旧 tag 的工作流不会自动使用新配置。

流程开始时检查五个 Secrets 是否齐全，打包时启用 `forceCodeSigning` 和公证，上传前对 `release/mac-arm64/片场.app` 与 `release/mac/片场.app` 分别运行：

```bash
codesign --verify --deep --strict --verbose=2 "片场.app"
spctl --assess --verbose --type execute "片场.app"
xcrun stapler validate "片场.app"
```

Gatekeeper 应显示 `accepted` 与 `source=Notarized Developer ID`，票据校验应显示 `The validate action worked!`。任一步失败都会阻止该平台上传和最终 Release 附件发布。electron-builder 26.18.0 在完全缺少公证凭据时可能只警告并跳过公证，所以不能只依赖 `mac.notarize: true`。

首次成功后，从 Actions 下载 DMG，安装并检查客户端启动、音色页录音以及安装页的试渲染。`build/entitlements.mac.plist` 保留 electron-builder 的 Electron 运行权限，并为应用及 Helper 加上 Hardened Runtime 的 `audio-input` 权限；已有的 `NSMicrophoneUsageDescription` 继续保留。自动校验不能代替这些实际功能检查。

公证可能需要较长时间，签名打包步骤设有 60 分钟超时；超时后先检查 Apple 服务状态和 Actions 日志，再重跑。

## 本地开发

本地 `npm run dist -w onset-desktop` 不强制要求发布证书；electron-builder 按本机可用身份签名，没有身份时可能使用 ad-hoc 签名。公证只在提供对应凭据时进行。

需要明确生成未签名的本地测试包时，在完成构建后，从 `apps/desktop` 执行：

```bash
npx electron-builder --mac --dir -c.mac.identity=null -c.mac.hardenedRuntime=false -c.mac.notarize=false
```

## 参考

- [Apple：创建 Developer ID 证书](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [electron-builder v26：macOS 公证与 GitHub Actions 配置](https://www.electron.build/v26/docs/features/code-signing/notarization/)
- [Apple：Hardened Runtime 与音频输入权限](https://developer.apple.com/documentation/xcode/configuring-the-hardened-runtime)
