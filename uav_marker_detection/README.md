# UAV Marker Detection

Raspberry Pi 5 + Raspberry Pi Camera üzerinde çalışan, yukarıdan görülen kırmızı ve mavi yer işaretçilerini algılayıp JSON/UDP/MAVLink tarafına raporlayan modül.

Güvenlik sınırı: Bu kod yalnızca `red_marker` ve `blue_marker` sınıflarını algılar ve konum bilgisi raporlar. Otonom saldırı, hedefleme, angajman, görev değiştirme, arming, yönlendirme veya uçuş komutu gönderme davranışı içermez.

## Klasör Yapısı

```text
uav_marker_detection/
  config/                 # Kamera, HSV, geometri ve MAVLink ayarları
  src/
    main.py               # Ana çalışma döngüsü
    camera/               # PiCamera2 ve video dosyası kaynakları
    detection/            # Adaptive color, HSV fallback, YOLO/YOLO-seg detector
    tracking/             # Temporal smoothing / centroid tracking
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
python3 scripts/generate_sample_video.py
python3 src/main.py --config config/default.yaml --source video --video sample_data/test.mp4
```

MacBook kamerası veya video ile YOLO test:

```bash
./scripts/run_macbook_yolo.sh
SOURCE=video ./scripts/run_macbook_yolo.sh
```

Bu script varsayılan olarak `hybrid` detector kullanır: YOLO kutularını kırmızı/mavi renk doğrulamasından geçirir ve YOLO'nun kaçırdığı yüksek güvenli renk bölgelerini ekler. Ham sentetik YOLO modeli gerçek kamera görüntüsünde yanlış pozitif üretebildiği için canlı testte önerilen mod budur.

Detaylar için [RUN_MACBOOK.md](RUN_MACBOOK.md) ve sentetik eğitim için [TRAIN_SYNTHETIC.md](TRAIN_SYNTHETIC.md).

Raspberry Pi Camera ile:

```bash
python3 src/main.py --config config/default.yaml --detector color --source pi
```

Pixhawk/PX4 MAVLink UDP telemetri dinleme:

```bash
python3 src/main.py --config config/default.yaml --detector color --source pi --mavlink udpin:0.0.0.0:14550
```

`udpout:127.0.0.1:14550` yalnızca QGroundControl gibi bir endpoint'e mesaj göndermek için kullanılabilir; Pixhawk'tan gelen telemetriyi dinlemek için genelde `udpin:0.0.0.0:14550` gerekir.

YOLO inference:

```bash
python3 src/main.py --config config/default.yaml --detector yolo --weights models/best.pt --source pi
python3 src/main.py --config config/default.yaml --detector yolo_seg --weights models/best-seg.pt --source pi
```

## Detector Stratejisi

Mevcut eski HSV yaklaşımı gerçek kamera akışında güvenilir değildi:

- Pi camera renk formatı ve config uyumsuzluğu kırmızı/mavi kanallarını ters yorumlatabiliyordu.
- Config, detector sınıfındaki gevşetilmiş filtreleri eziyor ve hâlâ kare/dörtgen/yüksek extent bekliyordu.
- Mavi marker, düşük saturation/gölge/white balance değişiminde dar HSV aralığından çıkıyordu.
- Motion blur ve perspektif bozulması contour vertex/aspect filtrelerini kırıyordu.
- Tek frame çıktısı zıplamayı ve kısa detection kayıplarını yumuşatmıyordu.

Güncel akış:

- Varsayılan hızlı detector: `color`. HSV + normalize RGB renk baskınlığı + Lab renk ipuçlarını birleştirir, kare zorunluluğu yoktur.
- Debug fallback: `hsv`. Genişletilmiş HSV eşikleriyle hızlı maske testi için tutulur.
- Üretim için önerilen ana model: `yolo_seg`. Gerçek Pi Camera verisiyle eğitilmiş YOLO nano segmentation modeli, karmaşık zemin/motion blur/ışık değişiminde en doğru yoldur.
- Tüm detector çıktıları centroid tracker’dan geçer; bbox/merkez yumuşar ve kısa süreli kayıplarda track hemen düşmez.

Debug mask örnekleri:

```bash
python3 src/main.py --config config/default.yaml --detector color --source video --video sample_data/test.mp4 --draw-debug --debug-view mask_blue
python3 src/main.py --config config/default.yaml --detector color --source video --video sample_data/test.mp4 --draw-debug --debug-view mask_overlay
```

## GUI

Qt tabanlı canlı arayüz:

```bash
python3 src/gui/app.py --config config/default.yaml
```

Arayüzde canlı kamera/video görüntüsü, bbox/label/confidence/merkez overlay, anlık tespit tablosu, FPS/model/kamera/telemetry durumu, canlı MAVLink telemetri tablosu, debug mask görünümü, JSON/UDP/MAVLink çalışma modları ve Pixhawk bağlantı paneli bulunur. PyQt6 veya PySide6 gerekir. Raspberry Pi OS için önerilen kurulum:

```bash
sudo apt install python3-pyqt6
```

`Pixhawk / MAVLink` panelinde UDP için varsayılan dinleme adresi `udpin:0.0.0.0:14550` değeridir. Heartbeat gelince GUI mode/armed, attitude, local/global position, altitude, airspeed, groundspeed, battery, GPS, pressure, RC RSSI ve son görülen raw MAVLink mesaj alanlarını canlı listeler. USB-UART dönüştürücü yokken `simulation` seçilip `Connect` ile telemetry simülasyonu açılabilir. Gerçek dönüştürücü geldiğinde `serial`, `/dev/ttyUSB0`, `57600` veya `115200` seçilerek aynı panelden bağlanılır.

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

## Color / HSV Algılama Mantığı

`src/detection/adaptive_color_detector.py` şu adımları uygular:

1. Frame BGR kabul edilir; Pi camera config varsayılanı `BGR888`.
2. Hafif blur ve CLAHE ile ışık değişimi yumuşatılır.
3. HSV maskesi, normalize RGB renk baskınlığı ve Lab renk ipuçları birlikte kullanılır.
4. Kırmızı ve mavi maskelere morphological close/open uygulanır.
5. Contour alanı, renk doluluk oranı ve aşırı aspect ratio filtresi uygulanır.
6. Kare/dörtgen zorunluluğu yoktur; bbox, merkez, maske poligonu, kalite ve confidence üretilir.

HSV detector yalnızca hızlı debug/fallback için korunur. Eşikler `config/default.yaml` içinden ayarlanır.

## Tracking

`src/tracking/centroid_tracker.py` sınıf bazlı nearest-centroid tracking yapar. Track ID üretir, bbox/merkez smoothing uygular ve `tracking.max_missed` kadar frame boyunca kısa kayıpları tutar. JSON çıktısında `track_id` ve `stale_frames` alanları bulunur.

## Raspberry Pi 5 Performans Beklentisi

Yaklaşık değerler 640x480 kamera ve `processing.resize_width=640` içindir:

- `color`: 15-30 FPS aralığı hedeflenir; GUI açıkken biraz düşebilir.
- `yolo` nano, `imgsz=320`: CPU üzerinde yaklaşık 6-12 FPS beklenir.
- `yolo_seg` nano, `imgsz=320`: CPU üzerinde yaklaşık 3-8 FPS beklenir.
- NCNN/ONNX export ve daha düşük çözünürlük FPS'i artırabilir.

Gerçek FPS kamera exposure süresi, GUI, logging, model boyutu ve Pi soğutmasına bağlıdır.

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
