---
name: hub-setup
description: "Use when setting up Agents Hub on a new Hermes install, creating a new agent, or explaining how the Hub is wired (team roster, avatars, accounts, usage)."
version: 1.0.0
---

# Khởi tạo Agents Hub và tạo agent

## Cài đặt (một lần)

```
hermes plugins install mynamezxc/gaugau-agent      # hoặc clone vào <HERMES_HOME>/plugins/agents-hub
hermes plugins enable agents-hub
```

Khởi động lại gateway (Desktop: Ctrl+K → "Restart gateway"), rồi bật plugin desktop "Agents Hub" trong
Capabilities → Plugins và mở trang `/hub`.

Lần đầu mở Hub, plugin tự làm phần khởi tạo. Bấm "Chạy lại khởi tạo" ở tab Cấu hình nếu muốn làm lại. Phần khởi tạo gồm:
- `agents-hub/team.json`: mỗi profile Hermes thành một thành viên. Tên lấy từ `display_name` trong `profile.yaml`,
  vai trò lấy từ `description`, mặc định báo cáo cho `default`, và có avatar ngẫu nhiên.
  Mục đã có sẵn thì giữ nguyên, owner sửa trong tab Cấu hình.
- `agents-hub/TEAM.md`: cùng danh sách đó, viết cho agent đọc khi điều phối.
- `agents-hub/setup.json`: đánh dấu phiên bản đã khởi tạo.

Hub không sửa `SOUL.md` hay `config.yaml` của các profile đang có.

## Tạo agent mới

Tạo trong Hub: tab Cấu hình → "Tạo agent". Nhập id, tên, vai trò, năng lực, báo cáo cho ai, và sao chép cấu hình từ ai.
Hub gọi `hermes_cli.profiles.create_profile(id, clone_from=…, clone_config=True)` để agent mới dùng cùng đăng nhập
model, ghi `profile.yaml` (tên và mô tả), viết `SOUL.md` theo vai trò (có trỏ tới skill `agents-hub:hub-operating`
và `TEAM.md`), thêm agent vào nhóm với avatar ngẫu nhiên, rồi sinh lại `TEAM.md`.

Tạo từ terminal cũng được, Hub tự nhận profile mới ở lần mở sau:
`hermes profile create <id> --clone` rồi sửa `profiles/<id>/SOUL.md`.

Avatar là khuôn mặt hoạt hình sinh từ một seed. Seed ngẫu nhiên khi tạo agent, bấm "Đổi avatar" để lấy mặt mới.
Nét mặt đổi theo việc agent đang làm: tập trung khi chạy lệnh, suy nghĩ khi suy luận, đặt câu hỏi khi chờ quyền,
vui khi vừa xong, đợi lệnh khi rảnh, ngủ khi ngoại tuyến.

## Tài khoản và usage

Tab Cấu hình dùng đúng các luồng đăng nhập của Hermes:
- Codex (ChatGPT): luồng device-code của Hermes. Hub hiện mã và link, owner xác nhận trên trình duyệt.
- Claude: chạy `hermes [-p <id>] auth add anthropic`, mở link authorize, owner dán mã vào ô trong Hub.
  Đăng nhập sẵn có của Claude Code (`~/.claude`) cũng được nhận.

Dưới ô chat là usage của Claude và Codex: phiên 5 giờ, tuần, thời điểm reset, và lúc token hết hạn hoặc tự làm mới.
Số liệu lấy qua bộ đọc usage của Hermes (chỉ đọc, không làm mới token), lưu tạm 10 phút, và luôn hiện số gần nhất.
Không bao giờ in, chép hay gửi token. Hub chỉ trả về trạng thái và phần trăm.
