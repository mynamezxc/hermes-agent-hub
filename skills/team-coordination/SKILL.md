---
name: team-coordination
description: "Use when work needs more than one agent in an Agents Hub team: read TEAM.md, pick members by role, hand off, follow up, review."
version: 1.0.0
---

# Điều phối công việc trong nhóm agent

Chỉ dùng skill này khi việc thật sự cần người khác. Việc làm một mình xong nhanh hơn thì tự làm.

## 1. Biết nhóm có ai

- Đọc `<HERMES_HOME gốc>/agents-hub/TEAM.md`, gồm: `id`, tên, vai trò, báo cáo cho ai, model và năng lực.
  Owner sửa danh sách trong Hub (tab Cấu hình) và Hub sinh lại tệp này.
- Cột "báo cáo cho" cho biết luồng giao việc: giao xuống cho người báo cáo cho mình, báo cáo lên người mình báo cáo.
  Không giao vượt cấp nếu không có lý do.

## 2. Chọn người

1. Tách yêu cầu thành các phần việc có đầu ra cụ thể (tệp, kết quả kiểm thử, bản nháp, quyết định).
2. Với mỗi phần, chọn thành viên có vai trò hoặc năng lực khớp nhất. Nếu hai người cùng phù hợp thì chọn người
   có cấp gần mình hơn.
3. Không ai phù hợp thì tự làm, hoặc báo owner rằng nhóm thiếu năng lực đó. Owner có thể tạo agent mới trong Hub.
4. Việc tạo ra sản phẩm quan trọng nên có một người khác review (ví dụ người phụ trách quy trình hoặc QA). Tác giả không tự chấm bài của mình.

## 3. Giao việc

Viết đề bài vào một tệp (`<thư mục việc>/<id>-<việc>.prompt.md`) gồm:
mục tiêu, phạm vi (tệp hoặc thư mục được đụng), ràng buộc (không làm gì: chi tiền, đăng ra ngoài, xóa dữ liệu, đọc
bí mật), tiêu chí nghiệm thu, hạn, và yêu cầu dòng cuối là **một dòng JSON** tóm tắt kết quả.

Gửi bằng lệnh (chạy nền nếu lâu):

```
hermes -p <id> chat -Q --oneshot --source tool --query-file <prompt.md>
```

Hub hiển thị lượt này thành hội thoại giữa hai agent, và người nhận hiện "Đang làm ở phiên khác" trong chat của họ.
Việc con nhỏ, không cần vai trò riêng thì dùng `delegate_task` (sub-agent) thay vì một agent khác.

## 4. Theo dõi và nghiệm thu

- Ghi mỗi phần việc đã giao thành một goal của mình, ví dụ "Dev Backend xong API đăng nhập (đã test)".
  Đánh `done` khi đã nhận và kiểm chứng kết quả.
- Đọc dòng JSON cuối và kiểm tra đầu ra thật (tệp, test, log). Không tin lời tự báo cáo.
- Kết quả chưa đạt thì giao lại kèm điểm cụ thể cần sửa. Sau 2 lần vẫn không đạt thì báo owner.

## 5. Báo cáo owner

Tóm tắt theo: kết quả, bằng chứng, vướng mắc, cần duyệt. Nêu ai đã làm phần nào.
Những việc cần owner quyết (chi phí, đăng ra ngoài, quyền truy cập, xóa dữ liệu) luôn hỏi trước, không tự làm.
