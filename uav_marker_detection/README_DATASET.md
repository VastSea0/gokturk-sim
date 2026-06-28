# Veri Seti ve YOLO Rehberi

Güvenilir saha performansı için ana veri kaynağı gerçek Raspberry Pi Camera görüntüsü olmalıdır. `color` detector hızlı test ve debug için çalışır; karmaşık zemin, hareket, blur ve ışık değişiminde üretim hedefi eğitimli YOLO detection veya tercihen YOLO segmentation modelidir.

## 1. Gerçek Pi Camera Verisi Toplama

Kırmızı/mavi 2x2 metre kare markerları farklı koşullarda kaydedin:

- Farklı yükseklikler.
- Direkt güneş, bulut, gölge.
- Farklı zeminler: çim, beton, toprak, pist.
- Farklı kamera açıları ve hafif motion blur.

Pi Camera ile hareketli video kaydı:

```bash
python3 scripts/record_pi_camera_video.py --output dataset_raw/videos/flight_like_001.mp4 --duration 90 --fps 20
```

Video dosyasından frame çıkarma:

```bash
python3 scripts/capture_dataset_frames.py --source video --video sample_data/test.mp4 --output dataset_raw/frames --every-n 10 --max-images 500
```

Pi Camera ile frame toplama:

```bash
python3 scripts/capture_dataset_frames.py --source pi --output dataset_raw/frames --every-n 15 --max-images 500
```

Bu görüntüler hem label için hem de `color` detector debug mask ayarı için kullanılır.

## 2. YOLO Veri Seti

İki sınıf kullanılır:

```text
0 red_marker
1 blue_marker
```

Önerilen etiketleme araçları:

- LabelImg: bbox detection için.
- CVAT
- Roboflow

Segmentation kullanılacaksa CVAT veya Roboflow ile polygon mask etiketleyin. YOLO segmentation label formatı şöyledir:

```text
class_id x1 y1 x2 y2 x3 y3 ...
```

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

- 500-1500 gerçek görüntü.
- Her sınıf için farklı ışık/yükseklik/zemin/hız örnekleri.
- En az yüzde 20 hareketli veya motion blur içeren frame.
- Sentetik veri ile destek.

## 3. Sentetik Veri

Gerçek veri azsa sentetik veri üretin:

Detection dataset:

```bash
python3 scripts/generate_synthetic_dataset.py --output synthetic_marker_dataset --count 800 --task detect
```

Segmentation dataset:

```bash
python3 scripts/generate_synthetic_dataset.py --output synthetic_marker_seg_dataset --count 800 --task segment
```

Script şunları üretir:

- Rastgele zemin dokusu.
- Kırmızı/mavi kare polygonlar.
- Perspektif bozulması.
- Motion blur, Gaussian blur, noise, brightness/contrast, gölge, rotation/scale ve perspektif benzeri polygon bozulması.
- YOLO label dosyaları.
- `data.yaml`.

Sentetik veri tek başına saha başarısını garanti etmez. En iyi sonuç gerçek ve sentetik veriyi karıştırarak alınır.

## 4. YOLO Eğitimi

Ultralytics kurulumu:

```bash
pip install ultralytics
```

Detection eğitimi:

```bash
python3 scripts/train_yolo.py --data dataset/data.yaml --model yolov8n.pt --task detect --epochs 100 --imgsz 640
```

Segmentation eğitimi:

```bash
python3 scripts/train_yolo.py --data dataset_seg/data.yaml --model yolov8n-seg.pt --task segment --epochs 120 --imgsz 640
```

Validation:

```bash
python3 scripts/validate_yolo.py --weights runs/marker_yolo/red_blue_markers/weights/best.pt --data dataset/data.yaml --imgsz 640
```

Raspberry Pi export:

```bash
python3 scripts/export_yolo.py --weights runs/marker_yolo/red_blue_markers/weights/best.pt --format ncnn --imgsz 320
python3 scripts/export_yolo.py --weights runs/marker_yolo/red_blue_markers/weights/best.pt --format onnx --imgsz 320
```

Inference:

```bash
python3 src/main.py --config config/default.yaml --detector yolo --weights runs/marker_yolo/red_blue_markers/weights/best.pt --source video --video sample_data/test.mp4
python3 src/main.py --config config/default.yaml --detector yolo_seg --weights runs/marker_yolo/red_blue_markers/weights/best.pt --source pi
```

Pi üzerinde performans için:

- `imgsz=320` ile başlayın.
- YOLOv8n/YOLO11n veya YOLOv8n-seg/YOLO11n-seg gibi nano model kullanın.
- Pi 5 CPU üzerinde detection nano model pratik olabilir; segmentation daha pahalıdır. Gerekirse NCNN export deneyin.
- `color` detector canlı debug/fallback için kalır, gerçek yüksek güven için saha verisiyle eğitilmiş model kullanın.

## 5. Hazır Veri Seti Notu

Bu problem çok spesifik olduğu için genel object detection veri setleri doğrudan uygun değildir. Kırmızı/mavi 2x2 metre marker, kamera yüksekliği, lens ve yer dokusu saha özelidir. En doğru yol kendi uçuş/test görüntülerinizden veri üretmektir.
