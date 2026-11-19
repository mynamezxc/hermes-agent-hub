# Agents Hub: đề xuất quản lý dự án và agent

**Đã tích hợp:** phần Project delivery trong Workflow, liên kết Project/Board/Goal/Task, nghiệm thu và lưu trữ có lịch sử, xem trước goal cũ và tạo thẻ chờ chủ sở hữu duyệt. Codex và Claude dùng worker Hermes nạp skill tương ứng; Gemini dùng model override. Tích hợp trực tiếp vòng đời CLI, chính sách sandbox riêng theo dự án và công cụ áp dụng migration theo batch vẫn là các bước mở rộng, không phải tính năng đã bật.

## 1. Dùng Hermes Projects và Kanban làm nguồn dữ liệu gốc

- **Project** xác định repo, board, thành viên và chính sách quyền. Hub chọn project bằng ID và hiển thị board đã liên kết. Không ngầm dùng board mặc định nếu người dùng đang ở dự án khác. Dùng API/CLI của Hermes để cập nhật Kanban, không tự ghi SQLite.
- **Goal** là kết quả cần nghiệm thu, không phải bước thao tác. Mỗi goal có owner, reviewer, tiêu chí đo được, task bắt buộc và bằng chứng. Mỗi project có một goal hiện hành, mặc định tối đa ba goal đang mở. Nếu yêu cầu nhỏ giải quyết ngay, không tạo goal; nếu cần bàn giao thì dùng card.
- **Task** có một assignee, đầu ra, phạm vi quyền, tiêu chí và phụ thuộc. **Run** là một lần thực thi task, có runtime, mã phiên, mốc cập nhật, kết quả kiểm tra và lý do dừng. Retry không tạo goal, không đổi task ID. Agent coder nhìn thấy task và goal cha, không nhận bản sao goal riêng.
- Overview hiển thị theo project: goal hiện hành, `task bắt buộc đã nghiệm thu / tổng`, người đang làm, task chờ review, blocker chờ ai và hành động kế tiếp. Heartbeat là tín hiệu hoạt động, không phải phần trăm hoàn thành.

## 2. Nghiệm thu và dọn goal có lịch sử

Task đi từ `Ready → Running → Review → Done`. Agent nộp diff và test để vào `Review`; reviewer xác minh đầu ra và có thể trả lại cùng card. Goal chỉ đóng khi task bắt buộc đã được nghiệm thu và có bằng chứng ở cấp goal. Ví dụ: tất cả PR đã merge không đồng nghĩa với việc chạy staging đã đạt.

Dùng sự kiện Kanban và một bước đối soát khi Hub khởi động để cập nhật trạng thái; không phụ thuộc vào việc agent nhớ ghi tag trong chat. Mở lại task bắt buộc sẽ đưa goal vào trạng thái cần nghiệm thu lại. Mọi lần đóng, mở lại, lưu trữ phải ghi ai làm, thời điểm, lý do và tham chiếu bằng chứng.

Migration chỉ đọc trước: liệt kê goal cũ và đề xuất **giữ kèm owner/ngày kiểm lại**, **đóng có bằng chứng** hoặc **lưu trữ có lý do**. Không tự gán project nếu không chắc; để mục chưa phân loại. Cho chủ sở hữu duyệt từng thay đổi hoặc duyệt một batch đã xem trước. Không xóa vĩnh viễn theo tuổi, không sửa hay quét dữ liệu thật trong quá trình thử migration.

## 3. Runner riêng, cùng một quy trình

| Runtime | Ai quản lý công cụ và cách thực thi | Vai trò phù hợp |
|---|---|---|
| Codex CLI | Codex | Viết code/test hoặc review độc lập trong worktree của task |
| Claude Code | Claude Code | Review chỉ đọc, phân tích kiến trúc hoặc triển khai với skills/subagents đã duyệt |
| Hermes + Gemini API key | Hermes; Gemini chỉ cung cấp model | Phân tích, tài liệu, QA hoặc coding dùng tools của Hermes |
| Gemini CLI (tùy chọn sau) | Gemini CLI, qua adapter riêng | Chỉ thêm nếu dự án cần tooling bản địa và đã xác minh khả năng cấu hình quyền |

Hub gửi brief tối thiểu: project/task, commit gốc, phạm vi file, đầu ra, lệnh kiểm tra, quyền và ngân sách. Adapter ánh xạ sự kiện runner thành tiến độ đã lọc; kết quả gồm commit/diff, test, blocker và mã phiên. Chỉ resume nếu khớp project/task/runtime. Trạng thái thoát thành công không tự đóng task. Không mặc định dùng nhiều model cho một task; dùng reviewer độc lập khi thay đổi cần nghiệm thu.

**Bảo mật:** key/OAuth nằm ở kho xác thực của Hermes hoặc runner; Hub lưu tham chiếu, không lưu key. Cho phép theo dự án các repo, provider, MCP, network và loại dữ liệu có thể gửi. Dùng sandbox/VM cho repo nhạy cảm, không mount thư mục cá nhân hoặc cấp production secrets; worktree chỉ phân tách thay đổi Git. Push, merge, deploy và cấp quyền mới phải phê duyệt riêng. Log và artifact đã lọc, có thời hạn lưu; không gửi toàn bộ chat vào CLI và không coi nội dung repo/log là chỉ thị cấp quyền.

## 4. Triển khai theo từng mốc

1. **Project + board:** selector, lọc Overview và link đúng board/task; kiểm thử hai project, không đọc nhầm board hoặc vô tình sửa task bên kia.
2. **Goal + review:** liên kết task bắt buộc, ghi nhận bằng chứng, đánh dấu thiếu nghiệm thu sau restart, và màn hình xem trước dọn goal cũ. Kiểm thử review fail, review pass, task bị mở lại và việc nhỏ không sinh goal.
3. **Pilot runner:** một goal, Codex triển khai trong worktree, reviewer độc lập kiểm Git diff và test. Kiểm thử tắt runner, không mang session sang task khác, từ chối đường dẫn ngoài phạm vi và không lưu secret. Sau đó thêm Claude Code và Gemini theo nhu cầu.

**Ví dụ đạt:** Billing có một goal “Đối soát hóa đơn tự động trên staging”. Agent triển khai, agent review và staging QA là ba task. Sau khi code/test qua review nhưng QA chưa có bằng chứng, Overview ghi `2/3` và goal vẫn mở. Chỉ khi QA xác nhận kết quả staging, goal mới được đóng; lịch sử vẫn giữ sau khi lưu trữ.
