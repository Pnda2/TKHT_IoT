# Hệ thống giám sát & tưới tiêu thông minh ESP32

Dashboard tiếng Việt, **Light Theme** (`#f8fafc`, card `#ffffff`), DHT22, OLED SH1106 128×64, tưới theo ngưỡng và suy luận Edge AI trực tiếp trên ESP32. Gemini là trợ lý tư vấn tùy chọn trên web; firmware không cần Internet để đọc cảm biến, dự đoán, kiểm tra dòng nước hoặc điều khiển tưới.

## Chân phần cứng (giữ nguyên)

| Thiết bị | GPIO |
| --- | --- |
| OLED SDA / SCL | 21 / 22 |
| Độ ẩm đất ADC | 34 |
| Mực nước ADC | 35 |
| Relay active LOW | 23 |
| Cảm ứng TTP223 | 4 |
| DHT22 | 15 |

## Chạy firmware

1. Cài ESP32 core và thư viện **Adafruit GFX Library**, **Adafruit SH110X**, **Adafruit BusIO**, **DHT sensor library**, **Adafruit Unified Sensor** trong Arduino IDE.
2. Mở `sketch_oct23a/sketch_oct23a.ino`, cấu hình WiFi và chọn đúng board ESP32. Nạp firmware bằng Arduino IDE hoặc `arduino-cli compile --fqbn esp32:esp32:esp32 sketch_oct23a` rồi upload vào cổng của board.
3. Serial Monitor 115200 hiển thị IP. Sau khoảng 5 giây không có STA, lúc khởi động hoặc khi rớt mạng, thiết bị mở AP `ESP32_SmartGarden` (mật khẩu `12345678`, IP thường là `192.168.4.1`). ESP32 tiếp tục thử nối STA và giữ AP đã mở. Thiết bị ở mạng STA cần tự nối AP và đổi IP trên web khi router mất kết nối.
4. DHT22 đọc mỗi **2000 ms**. OLED hiển thị phút dự kiến chạm ngưỡng khô, trạng thái bơm và cảnh báo đường nước.

## Chạy web

Tại thư mục dự án:

```powershell
python -m http.server 8080 --bind 127.0.0.1 --directory web
```

Mở [dashboard cục bộ](http://localhost:8080), nhập IP/hostname ESP32, bấm **Kết Nối Lại**. Máy tính và ESP32 cần cùng mạng. Trường IP chỉ có hiệu lực khi bấm kết nối lại. Dùng HTTP cục bộ để tránh trình duyệt chặn mixed content khi gọi ESP32 HTTP từ trang HTTPS; trình duyệt có thể yêu cầu quyền truy cập mạng cục bộ.

Chart.js được tải từ CDN. Nếu không có Internet, các cảm biến, điều khiển và Demo vẫn hoạt động, biểu đồ hiển thị thông báo thay thế. Server ESP32 cung cấp REST API; ba file trong `web/` được phục vụ riêng trên máy tính.

## Điều khiển và phản hồi vật lý

- Nút bơm khóa ngay khi gửi lệnh; spinner chỉ xuất hiện sau **180 ms** nếu chưa nhận phản hồi. Chỉ hiện toast 200 OK sau phản hồi HTTP thành công và nhận được dữ liệu trạng thái hợp lệ.
- Lệnh bơm mới gửi trạng thái mong muốn `state=0/1`, tránh đảo bơm lại khi lặp cùng lệnh. Không tự gửi lại lệnh khi timeout; web đọc lại trạng thái thực tế. Phản hồi poll cũ không được ghi đè kết quả lệnh hay dữ liệu Demo.
- Bật/tắt bơm thủ công chuyển sang MANU. AUTO bật khi đất dưới ngưỡng khô, tắt khi đạt ngưỡng đủ ẩm. Ngưỡng hợp lệ: khô 10–60%, đủ ẩm 50–95%, khô < đủ ẩm; lưu trong Preferences.
- Mực nước dưới **15%** khóa/ngắt bơm. Vòng lặp kiểm tra mức nước theo chu kỳ mục tiêu **200 ms**, lấy trung vị 5 mẫu ADC và đọc lại trước khi bật thủ công. HTTP/OLED chậm có thể kéo dài chu kỳ này.
- Timer ESP32 ngắt GPIO relay khi vượt mốc **60 giây** với chu kỳ kiểm tra **20 ms**, độc lập với xử lý HTTP trong vòng lặp. AUTO bị khóa sau timeout cho đến lần bật thủ công. Nếu khởi tạo timer thất bại, firmware khóa bật bơm. Mạch ngắt độc lập vẫn cần thiết nếu yêu cầu bảo vệ cả khi MCU treo hoặc relay dính tiếp điểm.
- Ngưỡng khô/ẩm ghi chung một khóa NVS, chỉ cập nhật ngưỡng đang chạy sau khi ghi thành công. Firmware tiếp tục đọc hai khóa cũ nếu chưa có cấu hình mới.
- Dòng nước được suy ra từ đất tăng ít nhất **2 điểm %** hoặc nước bình giảm ít nhất **2 điểm %**. Đây là phản hồi gián tiếp từ cảm biến, không phải lưu lượng kế.
- Khi đang bơm, nếu không có biến thiên trên trong **hơn 12 giây**, firmware bật `flow_anomaly`. Vì kiểm tra mỗi 2 giây, lần đầu thường cảnh báo tại khoảng giây 14. Kiểm tra tiếp theo dùng cửa sổ mới sau mỗi lần ghi nhận tiến triển, giúp phát hiện cả tắc ống giữa chu kỳ.
- Cảnh báo bất thường giữ đến lần bật bơm tiếp theo để người dùng nhìn thấy; chức năng này cảnh báo, không tự ngắt bơm trước giới hạn 60 giây. Cần kiểm tra tuột ống, kẹt bơm, vị trí và kết nối cảm biến.

## Edge AI và hiệu chuẩn

`predictMinutesToDry(temp, hum, soil)` dùng hồi quy tốc độ mất ẩm:

```text
lossRate = clamp(0.12 + 0.008 × (temp − 25) − 0.0012 × (hum − 60), 0.02, 0.8)
minutes = ceil((soil − 40) / lossRate), giới hạn 1–4320 phút
```

`lossRate` có đơn vị điểm % độ ẩm đất/phút. Đất ≤40% trả 0; DHT22 lỗi trả `ai_dry_min=-1`. Mốc dự đoán **40%** độc lập với ngưỡng bật bơm tùy chỉnh. Các hệ số là khởi tạo kinh nghiệm, chưa được huấn luyện/xác thực bằng bộ dữ liệu thực nghiệm; cần thu thập chuỗi số đo cho loại đất, cây và chậu thực tế để hiệu chỉnh trước khi sử dụng như dự báo tin cậy. Đây là phép suy luận hồi quy C++ nhẹ, không tích hợp mô hình TensorFlow đã huấn luyện.

Hiệu chuẩn ADC hiện giữ nguyên: đất khô 3500, ướt 1400; mức nước khô 200, đầy 2600. Điều chỉnh theo cảm biến thực tế. Biến thiên 2 điểm % và cửa sổ 12 giây cũng cần thử với tốc độ bơm/dung tích bình để tránh báo sai do nước ngấm chậm hoặc nhiễu ADC.

## Gemini Cloud AI

Nhập key, chọn model rồi **Lưu cấu hình**; có nút ẩn/hiện key. Key chỉ lưu trong `localStorage` của trình duyệt đang dùng và gửi đến Google bằng header `x-goog-api-key`, không gửi đến ESP32. Có thể xóa key bằng cách để trống rồi lưu.

Ẩn key chỉ che ký tự hiển thị. Script chạy cùng origin hoặc người có quyền truy cập hồ sơ trình duyệt vẫn có thể đọc key. Với triển khai dùng chung, giữ key ở backend.

Nhận định cục bộ cập nhật theo mỗi mẫu cảm biến. Khi đã lưu key, Gemini tự phân tích lần đầu có dữ liệu mới và tối đa mỗi 5 phút khi trang đang hiện; có thể bấm phân tích hoặc hỏi trong chat. Dữ liệu quá 10 giây/mất kết nối không được đưa vào yêu cầu mới. Prompt chứa nhiệt độ, độ ẩm không khí/đất, mực nước, phút khô và các cờ an toàn. Dữ liệu Demo luôn được đánh dấu mô phỏng. Gemini chỉ tư vấn; không điều khiển relay.

Giữ endpoint REST `:generateContent` và lựa chọn `gemini-2.0-flash` theo yêu cầu. Vì Google đã ngừng model này, nếu nhận HTTP 404 với model 1.5/2.0, ứng dụng thử đúng một lần bằng `gemini-2.5-flash-lite` và cập nhật cấu hình khi thành công. Các lỗi key, quyền truy cập, quota, model và timeout được hiển thị riêng; không tự thử lại lỗi 429. Tham khảo [generateContent REST](https://ai.google.dev/api/generate-content) và [lịch ngừng model của Google](https://ai.google.dev/gemini-api/docs/deprecations).

## Demo và kiểm thử

Bấm **Chế độ Demo: BẬT** để chạy độc lập với phần cứng. Demo mô phỏng đất tăng/nước giảm theo thời gian khi tưới, chế độ AUTO/MANU, ngưỡng cài đặt và tự ngắt 60 giây. Chọn một trong ba kịch bản ngay dưới nút bơm:

1. **Tưới bình thường:** bật bơm, badge chuyển từ đang kiểm tra sang nước đang chảy tốt sau khi có biến thiên đủ lớn.
2. **Tắc dòng nước / tuột ống:** bật bơm, chờ hơn 12 giây để thấy cảnh báo; sau 60 giây tự ngắt.
3. **Bình cạn nước:** nút bật bơm bị khóa, banner cảnh báo hiện rõ.

Các cài đặt Demo chỉ lưu trong bộ nhớ mô phỏng. Khi đổi nguồn, dashboard xóa số đo, biểu đồ, nhật ký, thông báo và chat của phiên trước. Trình duyệt có thể trì hoãn tick Demo khi tab chạy nền.

```powershell
node --check web/app.js
node --test tests/app.test.cjs
```

Kiểm thử tự động sử dụng DOM/timer/network giả lập, kiểm tra mốc 180 ms, chống spam, lỗi HTTP/timeout, poll cũ, các kịch bản an toàn Demo, payload Gemini và bất biến theme/GPIO. Cần kiểm tra tiếp trên thiết bị thật để xác nhận ADC, relay, OLED, độ trễ tưới và chất lượng dự đoán. Gemini thật cần API Key hợp lệ và hạn mức của tài khoản.

## REST API

| Đường dẫn | Phản hồi |
| --- | --- |
| `GET /api/data` | Snapshot JSON cảm biến, bơm, ngưỡng và AI |
| `GET/POST /api/toggle?state=1` | Bật bơm thủ công, trả snapshot; `state=0` để tắt; HTTP 409 nếu bình cạn |
| `GET/POST /api/mode?mode=auto` | Chọn AUTO; `mode=manual` chọn MANU; trả snapshot |
| `GET/POST /api/settings?dry=40&wet=65` | Lưu Flash và trả snapshot; HTTP 400 nếu không hợp lệ |

## Thông báo Telegram

Firmware ESP32 tích hợp gửi thông báo trực tiếp qua Telegram Bot API (chạy ngầm trên Core 0 qua FreeRTOS Task, không làm chậm vòng lặp chính). Hệ thống tự động gửi tin nhắn khi:
- **Hệ thống online:** Kết nối Wi-Fi thành công, báo địa chỉ IP và trạng thái sẵn sàng.
- **Bắt đầu tưới:** Thông báo chế độ (AUTO / MANU), độ ẩm đất hiện tại và mực nước.
- **Tưới xong:** Báo độ ẩm đạt được, thời gian bơm thực tế và lượng nước còn lại.
- **Cảnh báo hết nước (<15%):** Khóa bơm khẩn cấp và gửi cảnh báo về điện thoại.
- **Cảnh báo timeout 60s:** Cưỡng chế ngắt bơm khi chạy liên tục quá 60 giây.
- **Cảnh báo dòng nước bất thường:** Bơm chạy > 12 giây nhưng đất không ẩm thêm và nước không giảm.

Dashboard gửi lệnh thay đổi bằng POST. HTTP 500 khi NVS không lưu được ngưỡng và HTTP 503 khi chốt thời gian chưa sẵn sàng hoặc đã can thiệp trong lúc bật bơm.

`/api/toggle` không truyền `state` vẫn hỗ trợ đảo trạng thái như phiên bản cũ. CORS OPTIONS chỉ trả preflight, không được thực thi lệnh. Các trường bổ sung: `ai_dry_min` (phút, -1 nếu thiếu DHT22), `dht_valid`, `flow_anomaly`, `flow_confirmed`; giữ nguyên các trường API cũ. API hiện phục vụ mạng LAN theo thiết kế ban đầu, chưa có xác thực người dùng.
