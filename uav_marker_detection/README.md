# UAV Marker Detection

Raspberry Pi 5 + Raspberry Pi Camera üzerinde çalışan, yukarıdan görülen kırmızı ve mavi kare yer işaretçilerini algılayıp JSON/UDP/MAVLink tarafına raporlayan modül.

Güvenlik sınırı: Bu kod yalnızca `red_marker` ve `blue_marker` sınıflarını algılar ve konum bilgisi raporlar. Otonom saldırı, hedefleme, angajman, görev değiştirme, arming, yönlendirme veya uçuş komutu gönderme davranışı içermez.

## Klasör Yapısı

```text
uav_marker_detection/
  config/                 # Kamera, HSV, geometri ve MAVLink ayarları
  src/
    main.py               # Ana çalışma döngüsü
    camera/               # PiCamera2 ve video dosyası kaynakları
    detection/            # HSV MVP ve opsiyonel YOLO detector
    geometry/             # Piksel -> relatif/global koordinat dönüşümü
    communication/        # JSONL, UDP JSON, MAVLink STATUSTEXT bridge
    gui/                  # PyQt6/PySide6 canlı operatör arayüzü
    utils/
  scripts/                # Kurulum, frame capture, sentetik veri, YOLO train
  systemd/                # Otomatik başlatma service örneği
  tests/                  # Donanımsız unit testler
```

## Hızlı Başlangıç

Geliştirme makinesinde:

```bash
cd uav_marker_detection
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pytest
```

Video dosyasıyla donanımsız test:

```bash
python3 src/main.py --config config/default.yaml --detector hsv --source video --video sample_data/test.mp4
```

Raspberry Pi Camera ile:

```bash
python3 src/main.py --config config/default.yaml --detector hsv --source pi
```

MAVLink UDP raporlama etkin:

```bash
python3 src/main.py --config config/default.yaml --detector hsv --source pi --mavlink udpout:127.0.0.1:14550
```

YOLO inference:

```bash
python3 src/main.py --config config/default.yaml --detector yolo --weights models/best.pt --source pi
```

## GUI

Qt tabanlı canlı arayüz:

```bash
python3 src/gui/app.py --config config/default.yaml
```

Arayüzde canlı kamera/video görüntüsü, bbox/label/confidence/merkez overlay, anlık tespit tablosu, JSON/UDP/MAVLink çalışma modları ve Pixhawk bağlantı paneli bulunur. PyQt6 veya PySide6 gerekir. Raspberry Pi OS için önerilen kurulum:

```bash
sudo apt install python3-pyqt6
```

USB-UART dönüştürücü yokken `Pixhawk / MAVLink` panelinde `simulation` seçilip `Connect` ile telemetry simülasyonu açılabilir. Gerçek dönüştürücü geldiğinde `serial`, `/dev/ttyUSB0`, `57600` veya `115200` seçilerek aynı panelden bağlanılır.

## Çıktı Formatı

Her frame için JSON nesnesi üretilir. Terminale sadece marker bulunan frameler yazılır; JSONL logger varsayılan olarak tüm frameleri `logs/marker_detections.jsonl` içine ekler.

```json
{
  "timestamp": 1710000000.123,
  "frame_id": 152,
  "detections": [
    {
      "class": "red_marker",
      "confidence": 0.91,
      "bbox_xyxy": [120, 80, 220, 180],
      "center_px": [170, 130],
      "quality": 0.88,
      "area_px": 9801,
      "relative_position_m": {
        "x_forward": 3.2,
        "y_right": -1.4,
        "z_down": 20.0
      },
      "global_position": {
        "lat": null,
        "lon": null,
        "alt": null
      }
    }
  ]
}
```

## HSV Algılama Mantığı

`src/detection/hsv_marker_detector.py` şu adımları uygular:

1. BGR frame HSV renk uzayına çevrilir.
2. Kırmızı için iki hue aralığı, mavi için bir veya daha fazla aralık maskelenir.
3. Maskeye morphological open/close uygulanır.
4. Contour bulunur.
5. Alan, aspect ratio, dörtgenlik ve extent filtreleri uygulanır.
6. `bbox_xyxy`, merkez piksel, kalite ve confidence üretilir.

HSV eşikleri `config/default.yaml` içinden ayarlanır.

## Koordinat Varsayımları

İlk MVP bilinçli olarak basit bir model kullanır:

- Kamera yere dik bakıyor.
- Zemin düz.
- Altitude biliniyor veya `geometry.default_altitude_m` varsayılıyor.
- Kamera FOV değerleri yaklaşık biliniyor.
- Görüntünün üst tarafı araç ileri yönü, sağ tarafı araç sağ yönü kabul ediliyor.

Pixhawk telemetrisi yoksa sadece `relative_position_m` hesaplanır. MAVLink üzerinden attitude/global/local position gelirse local NED ve global lat/lon tahmini de üretilebilir. Gerçek uçuş öncesinde kamera intrinsic kalibrasyonu, lens distorsiyonu, kamera montaj açısı ve altitude kaynağı doğrulanmalıdır.

## Çıkış Kanalları

- Console JSON: Varsayılan açık, marker bulunan frameleri yazar.
- JSONL: Varsayılan açık, `logs/marker_detections.jsonl`.
- UDP JSON: `communication.udp.enabled` veya `--udp-host/--udp-port` ile.
- MAVLink: `pymavlink` ile telemetri okur ve marker özetini güvenli `STATUSTEXT` olarak gönderebilir.

MAVLink bridge uçuş komutu göndermez.

## Donanımsız GUI Testi

Örnek video üret:

```bash
python3 scripts/generate_sample_video.py
```

GUI'yi aç, `Run settings` panelinde `Simulation/video test` seç, video yolu olarak `sample_data/test.mp4` kullan ve `Start` düğmesine bas.

## Mevcut PX4/QGroundControl Projesiyle İlişki

Kök repodaki Node.js tabanlı PX4/QGC görselleştirme sistemi değiştirilmedi. Bu modül bağımsız çalışır. QGC/SITL tarafına bilgi vermek için UDP JSON veya MAVLink `STATUSTEXT` kullanılabilir. Simülasyon kamerası yoksa `--source video` ile kaydedilmiş veya sentetik video üzerinden test edilmelidir.
