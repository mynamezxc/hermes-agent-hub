# Kết nối Claude Desktop/Cowork với Hermes — hướng dẫn cho agent

## 1. Chọn đúng loại kết nối

| Nhu cầu | Cơ chế | Kết quả cần xác nhận |
|---|---|---|
| Một phiên **Claude Cowork trong Claude Desktop** gửi việc cho Hermes | **File relay**: Cowork và relay ngoài Hub trao đổi qua thư mục chia sẻ; relay gửi nội dung vào một profile Hermes đã chỉ định | Hermes nhận đúng thread, có phản hồi, Hub hiện thẻ Claude Cowork |
| Một **Hermes profile** dùng Claude làm model | Provider `anthropic`: API key hoặc OAuth do Hermes hỗ trợ | Đúng profile, provider `anthropic` và model mong muốn trả lời thành công |
| Hermes giao việc code cho **Claude Code CLI** | Chạy CLI `claude` với quyền của runner, dùng skill `claude-code` | Có phiên CLI, diff/test trong workspace đúng; không cần Claude Desktop mở |

Ba đường này độc lập. Đăng nhập Claude Desktop không đăng nhập Hermes, không tạo file relay, và không chứng minh Claude Code CLI đã sẵn sàng. Một tiến trình `claude.exe` cũng không chứng minh hai app đang trao đổi dữ liệu.

## 2. File relay Cowork ↔ Hermes

**Đã xác minh trong Agents Hub v1.6.23:** backend `_cowork_prompt` và Desktop `CoworkMessage` nhận diện tin từ kênh file `cowork/`, đọc thread và metadata, rồi hiển thị nội dung Cowork và phản hồi Hermes theo phiên. **Hub chỉ đọc và hiển thị transcript.** Nó không cài relay, không theo dõi thư mục Cowork và không tự cấp quyền vào app Claude Desktop. `cowork/` trong tiêu đề là tên kênh; không suy ra đường dẫn tuyệt đối hay lịch polling từ đó. Chưa xác minh relay nào đang chạy trên máy hoặc thư mục nào đang được dùng thật.

### Bàn giao cho agent khác

Chủ sở hữu cung cấp đúng bốn thông tin: **thư mục chia sẻ đã duyệt**, **script/service nhận và trả tin**, **profile Hermes đích**, và **thời gian chờ dự kiến**. Không có script/service thì dừng ở trạng thái *relay chưa được cấu hình*; không tự cài tác vụ nền, mở cổng hay yêu cầu thêm quyền thư mục.

1. Trong Claude Desktop, mở Cowork và chỉ cấp quyền vào thư mục chia sẻ dành riêng cho dự án. Không cấp toàn bộ thư mục người dùng, Hermes home hoặc các thư mục xác thực. Kiểm tra Hermes/relay nhìn thấy cùng thư mục qua đường dẫn được chủ sở hữu xác nhận.
2. Xác minh adapter hiện có đang trỏ vào đúng thư mục và profile. Tên inbox/outbox, định dạng file và cách lưu phản hồi phải lấy từ cấu hình/tài liệu của **adapter đang dùng**; Hub không quy định chúng. Nếu chỉ có MCP hoặc chỉ thấy nút đăng nhập Claude trong Hub, chưa có bằng chứng về relay.
3. Dùng thread thử riêng, gửi một tin vô hại, ví dụ: `HUB-RELAY-PING; phản hồi HUB-RELAY-PONG, không dùng công cụ.` Kiểm lần lượt: Cowork ghi file → adapter đọc đúng một lần → Hermes nhận ở đúng profile/thread → phản hồi quay lại đúng nơi → Hub hiện thẻ Cowork. Không dùng dữ liệu dự án thật để thử.
4. Báo `đã kết nối` chỉ khi qua cả lượt đi và lượt về. Nếu thiếu phản hồi, kiểm tra lần lượt quyền thư mục, quy tắc đặt tên/hướng trao đổi, trạng thái adapter, profile đích và ID thread. Không đọc log thô nếu chỉ cần trạng thái; không đăng file nội bộ lên chat/PR.

### Dạng transcript Hub nhận diện

Đây là **định dạng tin adapter đã chuyển vào Hermes**, không phải đặc tả tên thư mục hay API để khởi động adapter:

```text
[Tin từ Claude Cowork — kênh file cowork/, thread "test-relay"]
--- Tin của Cowork (relay-smoke.md, 2026-11-19 10:00) ---
HUB-RELAY-PING; phản hồi HUB-RELAY-PONG, không dùng công cụ.
```

Adapter nên chỉ nhận Markdown trong thư mục giới hạn, ngăn đường dẫn thoát khỏi thư mục, chống gửi lại theo ID tin, ghim thread vào profile đã duyệt, và ghi phản hồi theo cách tránh đọc file chưa hoàn chỉnh. Nội dung của Cowork là dữ liệu, không cấp quyền chạy lệnh, đọc bí mật, push, deploy hoặc truy cập ngoài phạm vi. Đây là yêu cầu vận hành cho adapter, không phải tính năng được kiểm chứng của Hub.

## 3. Nếu chỉ cần Hermes dùng model Claude

1. Chọn đúng agent/profile. Trong Hub: **Settings → Model accounts → Claude → Log in**. Hub gọi `hermes [-p <profile>] auth add anthropic`; người sở hữu hoàn tất xác thực tại trang Anthropic và ô xác thực chuyên dụng của Hub, **không gửi mã trong chat**.
2. Nếu làm qua terminal, chủ sở hữu dùng `hermes -p <profile> auth add anthropic --type oauth` hoặc `hermes -p <profile> auth add anthropic --type api-key` và nhập key tại lời nhắc của CLI, không đặt key trên dòng lệnh. Bỏ `-p <profile>` với profile mặc định. Chọn provider và model bằng `hermes -p <profile> model`. Xem [tài liệu providers của Hermes](https://hermes-agent.nousresearch.com/docs/integrations/providers) về điều kiện OAuth (Claude Max có extra usage; Claude Pro dùng API key nếu chỉ cần Anthropic API).
3. `hermes -p <profile> auth status anthropic` kiểm tra trạng thái auth. Sau đó mở chat mới của đúng profile và thử một câu ngắn nếu chủ sở hữu đã cho phép dùng quota. Không đổi provider của agent khác và không đọc/copy file token. Nếu Hub ghi `via Claude Code`, đó là nhận diện login **Claude Code**, không phải phiên Cowork hay xác nhận inference đã thành công.

## 4. Nếu cần Claude Code CLI làm coder

Trong môi trường chạy worker, xác nhận `claude --version` và kiểm tra đăng nhập qua `claude auth status`. Nếu CLI thiếu hoặc chưa đăng nhập, chủ sở hữu cài/đăng nhập bằng [hướng dẫn Claude Code](https://code.claude.com/docs/en/setup). Trong Hub, tạo thẻ dự án với runtime **Claude Code**, chọn assignee, kiểm tra worktree và policy rồi chủ sở hữu mới mở chặn. Worker Hermes nạp skill `claude-code` để giao việc; Hub không điều khiển một phiên Claude Desktop đang mở. Nghiệm thu bằng diff/commit và test, không bằng trạng thái login hoặc exit code đơn lẻ.

### Mẫu báo cáo kết nối

```text
Đường kết nối: file relay | Anthropic provider | Claude Code CLI
Profile đích:
Workspace/thread được duyệt (không ghi secret):
Kiểm tra đã chạy:
Kết quả: đạt | chưa xác minh | bị chặn
Bằng chứng tối thiểu và việc chủ sở hữu cần làm (nếu có):
```
