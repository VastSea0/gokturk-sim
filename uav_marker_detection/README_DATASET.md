# Veri Seti ve YOLO Rehberi

İlk çalışan sürüm HSV tabanlı olduğu için büyük veri seti şart değildir. Yine de güvenilir saha performansı için gerçek görüntülerle eşik ayarı yapılmalıdır. YOLO gerekiyorsa aşağıdaki süreçle veri seti üretilebilir.

## 1. HSV İçin Görüntü Toplama

Kırmızı/mavi 2x2 metre kare markerları farklı koşullarda kaydedin:

- Farklı yükseklikler.
- Direkt güneş, bulut, gölge.
- Farklı zeminler: çim, beton, toprak, pist.
- Farklı kamera açıları ve hafif motion blur.

Video dosyasından frame çıkarma:

```bash
python3 scripts/capture_dataset_frames.py --source video --video sample_data/test.mp4 --output dataset_raw/frames --every-n 10 --max-images 500
```

Pi Camera ile frame toplama:

```bash
python3 scripts/capture_dataset_frames.py --source pi --output dataset_raw/frames --every-n 15 --max-images 500
```

Bu görüntülerle HSV eşiklerini `config/default.yaml` içinde ayarlayın.

## 2. YOLO Veri Seti

İki sınıf kullanılır:

```text
0 red_marker
1 blue_marker
```

Önerilen etiketleme araçları:

- LabelImg
- CVAT
- Roboflow

YOLO klasör yapısı:

```text
dataset/
  images/
    train/
    val/
    test/
  labels/
    train/
    val/
    test/
  data.yaml
```

`data.yaml` örneği:

```yaml
path: /absolute/path/to/dataset
train: images/train
val: images/val
test: images/test
names:
  0: red_marker
  1: blue_marker
```

Başlangıç için öneri:

- 200-500 gerçek görüntü.
- Her sınıf için farklı ışık/yükseklik/zemin örnekleri.
- Sentetik veri ile destek.

## 3. Sentetik Veri

Gerçek veri azsa sentetik veri üretin:

```bash
python3 scripts/generate_synthetic_dataset.py --output synthetic_marker_dataset --count 800
```

Script şunları üretir:

- Rastgele zemin dokusu.
- Kırmızı/mavi kare polygonlar.
- Perspektif bozulması.
- Noise, brightness, blur ve gölge augmentasyonu.
- YOLO label dosyaları.
- `data.yaml`.

Sentetik veri tek başına saha başarısını garanti etmez. En iyi sonuç gerçek ve sentetik veriyi karıştırarak alınır.

## 4. YOLO Eğitimi

Ultralytics kurulumu:

```bash
pip install ultralytics
```

Eğitim:

```bash
python3 scripts/train_yolo.py --data synthetic_marker_dataset/data.yaml --model yolov8n.pt --epochs 80 --imgsz 640
```

Alternatif hafif model:

```bash
python3 scripts/train_yolo.py --data dataset/data.yaml --model yolo11n.pt --epochs 100 --imgsz 640
```

Inference:

```bash
python3 src/main.py --config config/default.yaml --detector yolo --weights runs/marker_yolo/red_blue_markers/weights/best.pt --source video --video sample_data/test.mp4
```

Pi üzerinde performans için:

- `imgsz=320` deneyin.
- YOLOv8n veya YOLO11n gibi nano model kullanın.
- HSV MVP yeterliyse YOLO'yu devre dışı bırakın.

## 5. Hazır Veri Seti Notu

Bu problem çok spesifik olduğu için genel object detection veri setleri doğrudan uygun değildir. Kırmızı/mavi 2x2 metre marker, kamera yüksekliği, lens ve yer dokusu saha özelidir. En doğru yol kendi uçuş/test görüntülerinizden veri üretmektir.

