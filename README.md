# Eksam Evaluator Server

一对一考试控制服务端（Express + Socket.IO）。

## 启动

```bash
npm install
npm run dev
```

- 管理员控制台：`http://localhost:3000/admin`
- 管理员密码在 `config.yml` 的 `adminPassword`

## 考试时钟（与考生端同步）

- 点击“开考”后，考生端开始自主计时。
- 考生端每 10 秒通过 WebSocket 上报一次 `elapsedSec`。
- 管理员控制台会显示最新同步到的“考试时钟”。

## 对接客户端

客户端通过 Socket.IO 连接（底层走 WebSocket，支持 `wss`）：
- 服务端地址：`http(s)://<server-host>:3000`
- 连接参数：`path=/socket.io`，query：`role=candidate`

当收到 `command`：
- `paper_check` / `collect_paper` 需要拍照，并向 `POST /api/candidate/photo` 上传 `multipart/form-data`：
  - `kind`: `paper_check` 或 `collect_paper`
  - `photo`: 图片文件

上传成功后会返回 `{ ok: true, url }`，管理员控制台可看到图片。
