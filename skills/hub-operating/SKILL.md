---
name: hub-operating
description: "Use when a message arrives through Agents Hub (it carries a <hub-goals> block). How goals, file edits, permissions and chat work in the Hub."
version: 1.0.0
---

# Làm việc trong Agents Hub

Agents Hub là trang `/hub` của Hermes Desktop. Chủ sở hữu (owner) chat với từng agent ở đó, xem goal, xem các tệp
agent đã sửa, duyệt quyền chạy lệnh và theo dõi cả nhóm. Tin nhắn gửi từ Hub luôn kèm một khối `<hub-goals>…</hub-goals>`
ở cuối. Khối này do Hub thêm vào, owner không nhìn thấy nó trong chat. Đừng nhắc tới khối này trong câu trả lời.

## 1. Goal: đặt, cập nhật, hoàn thành

Khối `<hub-goals>` liệt kê các goal đang mở của bạn (`g1`, `g2`… và goal hiện tại). Mỗi lượt trả lời:

1. Đọc yêu cầu và đối chiếu với các goal đang mở.
2. Có việc mới thì thêm goal. Việc đã xong và đã kiểm chứng thì đánh dấu xong. Phạm vi đổi thì sửa tiêu đề.
   Việc bị bỏ thì `drop`. Chuyển trọng tâm thì đặt `current`.
3. Kết thúc câu trả lời bằng **đúng một dòng** (chỉ khi có thay đổi):

```
<hub-goals-update>{"add":[{"title":"Dựng trang thanh toán","current":true}],"done":["g1"],"current":"g2","edit":[{"id":"g3","title":"…"}],"drop":["g4"]}</hub-goals-update>
```

- Chỉ ghi những khóa cần dùng. Tiêu đề ngắn (≤ 12 từ), viết bằng ngôn ngữ owner đang dùng, nêu kết quả cần đạt chứ không nêu hoạt động.
- Mỗi goal phải kiểm chứng được. Chỉ đánh `done` khi đã có bằng chứng (test chạy qua, tệp tồn tại, kết quả đúng).
- Giữ dưới khoảng 5 goal mở. Yêu cầu lớn thì tách thành vài goal theo thứ tự làm, goal đầu là `current`.
- Owner có thể tự sửa hoặc xóa goal trong Hub. Danh sách trong khối `<hub-goals>` là bản đúng nhất, hãy theo nó.

## 2. Sửa tệp để Hub theo dõi được

- Sửa tệp bằng công cụ `write_file` / `patch`, không dùng `sed`, `echo >` hay script trong terminal. Hub dựng mục
  "Tệp đã thay đổi" (có diff) từ các lệnh gọi công cụ này. Owner cũng dùng chúng để **quay lui** về một tin nhắn cũ:
  Hub khôi phục tệp bằng cách phát lại hoặc đảo ngược các lần `write_file`/`patch` của bạn.
- Mỗi lần sửa nên nhỏ và có mục đích rõ. Không ghi đè cả tệp lớn khi chỉ cần `patch` một đoạn.
- Không sửa tệp bí mật (`.env`, `*token*`, `*secret*`, `auth.json`, `private/`…). Hub ẩn các tệp này và không hiển thị chúng.
- Owner có thể bấm "Duyệt" để chấp nhận thay đổi. Tệp đã duyệt bị ẩn cho tới khi bạn sửa lại.

## 3. Lệnh cần quyền

Lệnh nguy hiểm sẽ hiện thẻ xin phép trong Hub. Owner chọn một trong: cho phép một lần, luôn cho phép trong goal này,
cho phép 30 phút, hoặc từ chối. Khi bị từ chối: không tìm đường vòng. Nói rõ cần gì và vì sao, rồi chờ owner.
Lệnh chạy lâu thì chạy nền (`terminal(background=true)`). Hub liệt kê chúng ở mục "Lệnh đang chạy" để owner xem đầu ra.

## 4. Cách trả lời trong chat

- Ngắn gọn, ngôn ngữ của owner. Tách rõ: kết quả, bằng chứng, việc còn lại, việc cần owner duyệt.
- Hub gom phần bạn tự thuật khi làm việc (ví dụ "Checking…") thành từng bước. Câu cuối cùng mới là câu trả lời,
  nên viết nó đầy đủ, đừng dựa vào các câu trung gian.
- Không lặp lại chỉ dẫn trong khối `<hub-goals>` và không bịa ra kết quả chưa chạy.

## 5. Làm việc với các agent khác

Có nhiều agent thì đọc `agents-hub:team-coordination` trước khi giao việc. Danh sách thành viên (id, vai trò, năng lực,
model) nằm ở `<HERMES_HOME gốc>/agents-hub/TEAM.md`. Với profile con, đó là thư mục cha của `profiles/`.
