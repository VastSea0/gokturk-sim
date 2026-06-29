# Raspberry Pi 5 Kurulum Rehberi

Bu rehber Raspberry Pi 5 8GB + Raspberry Pi Camera için hazırlanmıştır. Sistem headless çalışabilir.

## 1. Kamera Bağlantısı

1. Raspberry Pi kapalıyken camera ribbon kablosunu CSI portuna takın.
2. Kablonun yönünü kamera modülünüze göre kontrol edin.
3. Pi'yi açtıktan sonra kamera görünürlüğünü test edin.

```bash
rpicam-hello --list-cameras
rpicam-hello -t 3000
```

Eski Raspberry Pi OS imajlarında komut adı `libcamera-hello` olabilir.

## 2. Paket Kurulumu

```bash
cd /home/pi/gokturk-uav/uav_marker_detection
chmod +x scripts/install_pi5.sh scripts/run_pi5.sh
./scripts/install_pi5.sh
```

YOLO da kurulacaksa:

```bash
./scripts/install_pi5.sh --with-yolo
```

Kurulum scripti şunları yapar:

- `python3-venv`, `python3-picamera2`, `python3-opencv`, `python3-numpy` kurar.
- Varsa `python3-pyqt6` kurar.
- `.venv` ortamını `--system-site-packages` ile oluşturur.
- `PyYAML`, `pymavlink`, `pytest` kurar.
- OpenCV import testini yapar.

## 3. Kamera Testi

Picamera2 yolunu test:

```bash
source .venv/bin/activate
python3 src/main.py --config config/default.yaml --detector color --source pi --max-frames 50 --print-empty
```

Debug penceresi gerekiyorsa masaüstü oturumunda:

```bash
python3 src/main.py --config config/default.yaml --detector color --source pi --show --draw-debug
```

Headless SSH kullanımında `--show` kullanmayın.

GUI kamera testi:

```bash
python3 src/gui/app.py --config config/default.yaml
```

Arayüzde `Run settings` panelinde `Camera + processing`, kaynak olarak `pi`, detector olarak `color` seçin ve `Start` düğmesine basın. Maviyi debug etmek için `Debug view` alanında `mask_blue` veya `mask_overlay` seçin.

## 4. Detector Çalıştırma

Temel çalışma:

```bash
./scripts/run_pi5.sh --config config/default.yaml --detector color --source pi
```

Düşük CPU kullanımı için:

- `config/default.yaml` içinde `camera.width/height` değerlerini 640x480 veya daha düşük tutun.
- `processing.resize_width` değerini 640 veya 480 yapın.
- `debug.draw` ve `debug.show_window` kapalı kalsın.
- `processing.max_fps` değerini 10-20 arası kullanın.

HSV fallback:

```bash
./scripts/run_pi5.sh --config config/default.yaml --detector hsv --source pi
```

Mavi mask debug:

```bash
python3 src/main.py --config config/default.yaml --detector color --source pi --draw-debug --debug-view mask_blue --show
```

Color detector ayarları:

```yaml
detection:
  color:
    red_hsv_ranges:
      - lower: [0, 90, 70]
        upper: [10, 255, 255]
      - lower: [160, 45, 35]
        upper: [179, 255, 255]
    blue_hsv_ranges:
      - lower: [82, 35, 25]
        upper: [148, 255, 255]
```

Farklı ışık koşullarında bu değerleri gerçek görüntülerle ayarlayın.

Pi 5 FPS beklentisi:

- `color`: 15-30 FPS hedeflenir.
- `yolo` nano `imgsz=320`: yaklaşık 6-12 FPS.
- `yolo_seg` nano `imgsz=320`: yaklaşık 3-8 FPS.

Gerçek değerler soğutma, exposure, model export formatı ve GUI kullanımına bağlıdır.

Renk kararlılığı için kamera kontrolü:

```yaml
camera:
  controls:
    awb_enable: true
    ae_enable: true
    exposure_time_us: null
    analogue_gain: null
```

İlk testte otomatik exposure/white balance açık kalabilir. Eşik veya model validasyonu yapılırken aynı sahnede renklerin zıpladığını görürseniz iyi pozlanmış değerleri bulup `awb_enable: false`, `ae_enable: false`, `exposure_time_us` ve `analogue_gain` ile kilitleyin.

## 5. MAVLink / Pixhawk / QGroundControl

Serial örnek:

```yaml
communication:
  mavlink:
    enabled: true
    connection_string: /dev/ttyAMA0
    baud: 57600
```

UDP örnek:

```bash
python3 src/main.py --config config/default.yaml --detector color --source pi --mavlink udpin:0.0.0.0:14550
```

Pixhawk/PX4 telemetrisini UDP üzerinden Raspberry Pi'da dinlemek için genelde `udpin:0.0.0.0:14550` kullanılır. `udpout:127.0.0.1:14550` ise QGroundControl gibi bir endpoint'e sadece mesaj göndermek için kullanılabilir.

QGroundControl tarafında marker özetleri `STATUSTEXT` olarak görülebilir. Daha zengin entegrasyon için UDP JSON çıkışını bir ground-station uygulaması okuyabilir:

```bash
python3 src/main.py --config config/default.yaml --detector color --source pi --udp-host 127.0.0.1 --udp-port 15000
```

İleri MAVLink seçenekleri:

- `STATUSTEXT`: Basit durum mesajı, QGC'de hızlı doğrulama.
- `NAMED_VALUE_FLOAT` / `DEBUG`: Sayısal debug telemetrisi.
- `LANDING_TARGET`: Sadece güvenli yarışma/test senaryosunda, anlamı dikkatle belgelendiğinde.
- Custom MAVLink message: Uzun vadede en temiz veri şeması.

Bu modül uçuş kontrol komutu göndermez.

## 6. GUI Çalıştırma

Masaüstü oturumu veya ekran bağlı Pi üzerinde:

```bash
source .venv/bin/activate
python3 src/gui/app.py --config config/default.yaml
```

Arayüz modları:

- `Camera + processing`: canlı görüntü ve color/HSV/YOLO/YOLO-seg tespit.
- `Camera + JSON log`: tespitleri JSONL dosyasına yazar.
- `Camera + UDP output`: tespitleri UDP JSON olarak yollar.
- `Camera + Pixhawk/MAVLink`: Pixhawk telemetry okur, canlı telemetri tablosunu günceller ve marker özetini güvenli `STATUSTEXT` ile gönderebilir.
- `Simulation/video test`: USB-UART veya kamera olmadan video dosyasıyla test.

## 7. Pixhawk Telemetry Port -> USB-UART-TTL -> Raspberry Pi USB

Bağlantı şeması:

```text
Pixhawk TELEM TX  -> USB-UART RX
Pixhawk TELEM RX  -> USB-UART TX
Pixhawk GND       -> USB-UART GND
USB-UART USB      -> Raspberry Pi 5 USB
```

Voltaj seviyesini dönüştürücünüz ve Pixhawk telem port dokümanına göre doğrulayın. Tipik telem hatları TTL seviyesindedir; güç hattını bağlamadan önce donanım dokümanını kontrol edin.

Portu görmek:

```bash
ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null
dmesg | tail -40
```

Kullanıcı izinleri:

```bash
sudo usermod -a -G dialout $USER
newgrp dialout
```

Gerekirse geçici izin:

```bash
sudo chmod 666 /dev/ttyUSB0
```

GUI bağlantısı:

1. `Pixhawk / MAVLink` panelinde `serial` seçin.
2. Port olarak `/dev/ttyUSB0` veya görünen portu seçin.
3. Baudrate olarak önce `57600`, sonra gerekirse `115200` deneyin.
4. `Connect` düğmesine basın.
5. Heartbeat/telemetry gelince mode/armed, attitude, altitude, airspeed, groundspeed, battery, GPS, local/global position ve raw MAVLink mesaj alanları güncellenir.

## 8. Baudrate Seçimi

PX4/Pixhawk telem port ayarlarına göre baudrate seçilir. Yaygın değerler:

- `57600`: birçok telem radyo ve varsayılan seri bağlantı için.
- `115200`: companion computer ve hızlı telemetry için sık kullanılır.

PX4 parametrelerinde ilgili telem port baud ayarı QGroundControl üzerinden kontrol edilmelidir.

## 9. QGroundControl UDP/Serial Test

UDP/SITL testi:

```bash
python3 src/main.py --config config/default.yaml --detector color --source video --video sample_data/test.mp4 --mavlink udpout:127.0.0.1:14550
```

GUI'de UDP testi:

1. `Pixhawk / MAVLink` panelinde `udp` seçin.
2. Pixhawk/PX4 telemetrisini dinlemek için `udpin:0.0.0.0:14550` yazın.
3. `Connect` düğmesine basın.
4. Durum `Heartbeat OK` olmalı; yalnızca `Link open, waiting heartbeat` görünüyorsa UDP port açık ama Pixhawk heartbeat paketi gelmiyor demektir.
5. QGroundControl açıkken `STATUSTEXT` mesajlarını kontrol edin.

Serial test için QGroundControl aynı anda aynı serial portu açmamalıdır; portu tek süreç kullanabilir.

## 10. USB-UART Yoksa Bağlantı Simülasyonu

GUI'de:

1. `Run settings` panelinde `Simulation/video test` seçin.
2. `Pixhawk / MAVLink` panelinde `simulation` seçin.
3. `Connect` ile sahte altitude/yaw/global position üretimini başlatın.
4. `Start` ile örnek video veya kendi test videonuzu çalıştırın.

Bu mod gerçek Pixhawk bağlantısı yerine yalnızca koordinat dönüşümü ve arayüz akışını doğrular.

## 11. Gerçek Bağlantı Son Kontrol Listesi

- USB-UART dönüştürücü 3.3V TTL seviyeleriyle uyumlu.
- TX/RX çapraz, GND ortak.
- `/dev/ttyUSB0` veya doğru port görünüyor.
- Kullanıcı `dialout` grubunda.
- PX4 telem port baudrate değeri GUI seçimiyle aynı.
- QGroundControl aynı serial portu kilitlemiyor.
- GUI'de heartbeat, airspeed, attitude, altitude, battery, GPS ve raw MAVLink mesajları güncelleniyor.
- Marker bulununca JSON/UDP/MAVLink logları yerde doğrulanıyor.
- Kodun uçuş kontrol komutu göndermediği teyit ediliyor.

## 12. Systemd ile Otomatik Başlatma

Service dosyasındaki yolları kendi kurulum dizininize göre düzenleyin:

```bash
sudo cp systemd/uav-marker-detection.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable uav-marker-detection
sudo systemctl start uav-marker-detection
sudo journalctl -u uav-marker-detection -f
```

## 13. Log ve Debug Dosyaları

Varsayılan JSONL log:

```text
uav_marker_detection/logs/marker_detections.jsonl
```

Debug frame kaydı için `config/default.yaml`:

```yaml
debug:
  draw: true
  save_debug_frames: true
  debug_frame_dir: logs/debug_frames
```

## 14. Gerçek Test Öncesi Kalibrasyon Listesi

- Kamera netliği ve exposure sabitliği.
- HSV eşiklerinin sabah/öğle/gölge koşullarında doğrulanması.
- Kamera intrinsic kalibrasyonu.
- Kamera montaj roll/pitch/yaw ölçümü.
- Altitude kaynağı doğruluğu.
- Pixhawk telemetri lat/lon/attitude güncelliği.
- JSON/UDP/MAVLink loglarının yerde doğrulanması.
- Pervane ve uçuş güvenliği için ayrı saha prosedürü.
