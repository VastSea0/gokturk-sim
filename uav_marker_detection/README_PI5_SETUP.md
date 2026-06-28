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
- `.venv` ortamını `--system-site-packages` ile oluşturur.
- `PyYAML`, `pymavlink`, `pytest` kurar.
- OpenCV import testini yapar.

## 3. Kamera Testi

Picamera2 yolunu test:

```bash
source .venv/bin/activate
python3 src/main.py --config config/default.yaml --detector hsv --source pi --max-frames 50 --print-empty
```

Debug penceresi gerekiyorsa masaüstü oturumunda:

```bash
python3 src/main.py --config config/default.yaml --detector hsv --source pi --show
```

Headless SSH kullanımında `--show` kullanmayın.

## 4. HSV Detector Çalıştırma

Temel çalışma:

```bash
./scripts/run_pi5.sh --config config/default.yaml --detector hsv --source pi
```

Düşük CPU kullanımı için:

- `config/default.yaml` içinde `camera.width/height` değerlerini 640x480 veya daha düşük tutun.
- `processing.resize_width` değerini 640 veya 480 yapın.
- `debug.draw` ve `debug.show_window` kapalı kalsın.
- `processing.max_fps` değerini 10-20 arası kullanın.

HSV ayarları:

```yaml
detection:
  hsv:
    red_ranges:
      - lower: [0, 90, 70]
        upper: [10, 255, 255]
      - lower: [170, 90, 70]
        upper: [179, 255, 255]
    blue_ranges:
      - lower: [95, 80, 50]
        upper: [135, 255, 255]
```

Farklı ışık koşullarında bu değerleri gerçek görüntülerle ayarlayın.

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
python3 src/main.py --config config/default.yaml --detector hsv --source pi --mavlink udpout:127.0.0.1:14550
```

QGroundControl tarafında marker özetleri `STATUSTEXT` olarak görülebilir. Daha zengin entegrasyon için UDP JSON çıkışını bir ground-station uygulaması okuyabilir:

```bash
python3 src/main.py --config config/default.yaml --detector hsv --source pi --udp-host 127.0.0.1 --udp-port 15000
```

İleri MAVLink seçenekleri:

- `STATUSTEXT`: Basit durum mesajı, QGC'de hızlı doğrulama.
- `NAMED_VALUE_FLOAT` / `DEBUG`: Sayısal debug telemetrisi.
- `LANDING_TARGET`: Sadece güvenli yarışma/test senaryosunda, anlamı dikkatle belgelendiğinde.
- Custom MAVLink message: Uzun vadede en temiz veri şeması.

Bu modül uçuş kontrol komutu göndermez.

## 6. Systemd ile Otomatik Başlatma

Service dosyasındaki yolları kendi kurulum dizininize göre düzenleyin:

```bash
sudo cp systemd/uav-marker-detection.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable uav-marker-detection
sudo systemctl start uav-marker-detection
sudo journalctl -u uav-marker-detection -f
```

## 7. Log ve Debug Dosyaları

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

## 8. Gerçek Test Öncesi Kontrol Listesi

- Kamera netliği ve exposure sabitliği.
- HSV eşiklerinin sabah/öğle/gölge koşullarında doğrulanması.
- Kamera intrinsic kalibrasyonu.
- Kamera montaj roll/pitch/yaw ölçümü.
- Altitude kaynağı doğruluğu.
- Pixhawk telemetri lat/lon/attitude güncelliği.
- JSON/UDP/MAVLink loglarının yerde doğrulanması.
- Pervane ve uçuş güvenliği için ayrı saha prosedürü.

