# JRRP 图片网站上传

打开图片编号 **317**，在图片上连续点击 **5 次**（相邻两次间隔不超过 3 秒），即可打开上传面板。上传时需要服务端口令。图片按 `kayoko/kayoko_编号.格式` 存入与上一级 JRRP 插件相同的腾讯云 COS 存储桶；密钥不会写进网页。

## Vercel 设置

项目根目录应指向本仓库，保留根目录的 `index.html` 和 `api/upload.mjs`。在 Vercel 项目设置的 Environment Variables 中配置：

| 变量 | 用途 |
| --- | --- |
| `COS_SECRET_ID` | 腾讯云 COS SecretId，可参考上一级插件的 `COS_CONFIG.SecretId` |
| `COS_SECRET_KEY` | 腾讯云 COS SecretKey，可参考上一级插件的 `COS_CONFIG.SecretKey` |
| `UPLOAD_PASSWORD` | 自行设置的长随机上传口令；仅在上传面板输入 |

将这些变量设到实际使用的 Vercel 环境后重新部署。不要把密钥或上传口令提交到仓库。上传接口通过公开的图片 `HEAD` 请求探测编号；COS 密钥需要写入新对象的权限。

在 COS 存储桶的 **安全管理 → 跨域访问 CORS 设置** 中，为网站的实际 HTTPS 域名添加规则：

- 来源 Origin：网站完整源，例如 `https://example.vercel.app`（没有末尾 `/`）；有自定义域名时一并添加。
- 方法：`PUT`（现有图片加载使用的 `GET`、`HEAD` 规则也应保留）。
- Allow-Headers：`Content-Type`、`x-cos-forbid-overwrite`。
- 可选 Expose-Headers：`ETag`。

前端只向同站点 `/api/upload` 请求 60 秒有效的单对象签名，然后直接向 COS 上传。Vercel Function 不接收图片文件。上传限制为 20 MB，支持 PNG、JPEG、WebP、GIF；使用文件内容识别格式。若同一编号被并发占用，网页会重新申请编号并重试。COS 的 `x-cos-forbid-overwrite` 在未开启存储桶版本控制时防止覆盖已有对象；如果存储桶启用了版本控制，腾讯云不保证这一头部的防覆盖效果。

本地检查：`vercel dev`，并在本地环境配置同名变量。上传是实际写入 COS 的操作，验证时请使用准备加入图库的图片。
