# Eksam Evaluator Server

一对一考试控制服务端（Express + WebSocket）。

## 启动

```bash
npm install
npm run dev
```

- 管理员控制台：`http://localhost:3000/admin`
- 管理员密码在 `config.yml` 的 `adminPassword`

## 对接客户端

客户端通过 WebSocket 连接：
- `ws://<server-host>:3000/ws?role=candidate`

当收到 `command`：
- `paper_check` / `collect_paper` 需要拍照，并向 `POST /api/candidate/photo` 上传 `multipart/form-data`：
  - `kind`: `paper_check` 或 `collect_paper`
  - `photo`: 图片文件

上传成功后会返回 `{ ok: true, url }`，管理员控制台可看到图片。
