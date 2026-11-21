# SỔ TAY HƯỚNG DẪN LẮP RÁP SA BÀN SMART GARDEN (PHONG CÁCH LEGO)

Tài liệu hướng dẫn từng bước thi công mô hình hệ thống tưới thông minh sử dụng vật liệu Formex 5mm, mút xốp Oasis và giàn treo chống bắn nước.

---

## MỤC LỤC BẢN VẼ HƯỚNG DẪN
1. [Bản vẽ CAD kích thước chi tiết (Ban_Ve_Kich_Thuoc_CAD.jpg)](./Ban_Ve_Kich_Thuoc_CAD.jpg)
2. [Phối cảnh 3D tổng thể (So_Do_Tong_The_3D.jpg)](./So_Do_Tong_The_3D.jpg)
3. [Bước 1: Cắt và chuẩn bị khung Formex (Buoc_1_Cat_Khung_Formex.jpg)](./Buoc_1_Cat_Khung_Formex.jpg)
4. [Bước 2: Lắp ráp Hộp điều khiển & Linh kiện (Buoc_2_Lap_Rap_Hop_Dieu_Khien.jpg)](./Buoc_2_Lap_Rap_Hop_Dieu_Khien.jpg)
5. [Bước 3: Lắp Giàn treo tưới nước & Bồn mút xốp (Buoc_3_Lap_Gian_Treo_Va_Xop.jpg)](./Buoc_3_Lap_Gian_Treo_Va_Xop.jpg)
6. [Bước 4: Kết nối đường ống & Hoàn thiện (Buoc_4_Ket_Noi_Hoan_Thien.jpg)](./Buoc_4_Ket_Noi_Hoan_Thien.jpg)

---

## BƯỚC 1: CẮT TẤM FORMEX THEO KÍCH THƯỚC CHUẨN
- **Tấm sàn đế tổng (Part 1):** 40.0cm x 30.0cm (Formex 5mm).
- **Hộp kỹ thuật (Part 2):**
  - Mặt trước (khoét ô OLED 3.6x3.6cm, ô DHT11 1.5x1.5cm): 18.0cm x 10.0cm.
  - Mặt sau (khoét lỗ Jack DC 10mm): 18.0cm x 10.0cm.
  - 2 Mặt hông trái/phải: 11.0cm x 10.0cm.
  - Mặt nắp trên (mở được): 18.0cm x 12.0cm.
- **Khay bồn cây mút xốp (Part 3):**
  - Đáy khay: 20.0cm x 14.0cm.
  - 4 Thành be quanh khay: Cao 4.5cm. Dán keo 502/silicon kín 4 góc để chống thấm nước tuyệt đối.

---

## BƯỚC 2: LẮP RÁP HỘP ĐIỀU KHIỂN & LINH KIỆN ĐIỆN TỬ
- **Mặt ngoài Taplo:**
  - Gắn màn hình **OLED 1.3"** khớp vào ô vuông đã khoét.
  - Đẩy phần vỏ xanh của **DHT11** nhô ra ngoài ô thoáng khí để đo đúng nhiệt ẩm môi trường.
  - Dán nút chạm **TTP223** ở mặt trong của tấm Formex, dán icon ngón tay bên ngoài.
- **Bên trong hộp điều khiển:**
  - Bắt vít cố định board **ESP32 + Shield S-V-G**.
  - Bắt module **Relay 1 kênh 5V** và mạch hạ áp **LM2596** (đã chỉnh chiết áp ra chuẩn 5.0V).
  - Đặt máy bơm **R385** lên 2 dải **đệm cao su / mút xốp giảm chấn** để triệt tiêu tiếng ồn và chống rung sa bàn khi bơm hoạt động.

---

## BƯỚC 3: LẮP GIÀN TREO TƯỚI NƯỚC & KHỐI MÚT XỐP
- Đặt khối **mút xốp Oasis cắm hoa** (kích thước 19.5cm x 13.5cm x 4.0cm) vào lòng khay Formex.
- Lắp dựng **khung giàn treo chữ U ngược**:
  - 2 Cột đứng cao 15.0cm.
  - 1 Xà ngang dài 20.0cm nối 2 đỉnh cột.
- Kẹp ống nước silicon mềm dọc theo xà ngang, rẽ nhánh chia thành các đầu béc/vòi cắm chúc thẳng xuống vuông góc 90° vào mặt xốp.
- **Khoảng cách chống bắn nước:** Đầu vòi cách mặt xốp chỉ **1.5cm - 2.0cm**. Nước từ giàn chảy xuống sẽ thấm ngay lập tức vào mút xốp, không bắn ra ngoài dù chỉ 1 giọt!
- Cắm 2 chân của **Cảm biến độ ẩm đất** sâu ngập 2/3 vào khối mút xốp.

---

## BƯỚC 4: KẾT NỐI HOÀN THIỆN & ĐI DÂY NGHỆ THUẬT
- Đặt bình nước nhựa/mica trong suốt (12cm x 10cm x 12cm) vào góc sau bên phải.
- Gắn **Cảm biến mực nước D35** thẳng đứng bên trong bình nước, đáy cảm biến cách đáy bình 5mm.
- Nối ống hút nước từ đáy bình vào đầu hút (Inlet) của máy bơm R385.
- Nối ống xả (Outlet) của bơm lên giàn treo tưới cây.
- Bọc toàn bộ các cụm dây cảm biến bằng **ống xoắn ruột gà màu đen** để tạo vẻ ngoài công nghệ cao, gọn gàng, chuẩn sản phẩm IoT thương mại.
