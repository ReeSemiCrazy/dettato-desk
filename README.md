# Dettato Desk

一个带网页界面的本地音频转多轨 MIDI 工具，外加一个能播放 MIDI、预览和导出五线谱的乐谱工作台。核心转录能力来自 [kobimusic/dettato](https://github.com/kobimusic/dettato)，本项目只是它外面的一层 Web 封装，**不是官方项目，也没有 fork 上游代码**。

音频只在本地处理，不会上传到任何服务。

## 界面

| 页面 | 地址 | 功能 |
|---|---|---|
| 转录工作台 | <http://127.0.0.1:8765/> | 拖拽上传音频、选择推理设备、查看每轨钢琴卷帘、下载 MIDI / JSON |
| 乐谱工作台 | <http://127.0.0.1:8765/sheet> | 播放识别结果、调整速度与波形、分轨开关、五线谱预览、导出 MusicXML / PNG / PDF |

## 安装

需要 Python 3.13 和一个可用的 pip 环境。

```bash
# 1. 依赖（dettato、torch、numpy 等会一并安装）
pip install -r requirements.txt

# 2. 模型权重（约 108 MB，四个模型，下载到 ./weights/）
python download_weights.py
```

权重脚本默认从 `hf-mirror.com` 下载（适合无法直连 Hugging Face 的网络）。如果你能直连 Hugging Face，可以不跑这一步——dettato 会在首次转录时自动下载到自己的缓存目录；只要 `./weights/` 不存在，`server.py` 就不会覆盖默认行为。

### GPU 加速（可选，推荐）

PyPI 上的 torch 默认是 CPU 版。有 NVIDIA 显卡的话，换成 CUDA 版能快 20 倍以上：

```bash
pip install --index-url https://download.pytorch.org/whl/cu128 --force-reinstall --no-deps torch==2.11.0+cu128
```

验证：`python -c "import torch; print(torch.__version__, torch.cuda.is_available())"` 应输出 `2.11.0+cu128 True`。

> 国内网络若官方源太慢，可从阿里云 PyTorch 镜像下载对应 wheel 后本地安装：
> <https://mirrors.aliyun.com/pytorch-wheels/cu128/>。
> `download_torch.py` 是该镜像的分块并行下载器（16 线程），仅在官方源限速时有需要；它下载到 `~/.cache/wheels/`，不进项目目录。

## 运行

```bash
python server.py --port 8765
```

Windows 用户也可以直接双击 `start.bat`。然后打开 <http://127.0.0.1:8765/>。

可选参数：`--device auto|cuda|cpu|mps`、`--host`、`--port`。

## 说明

- **转录结果不量化到节拍**，保留演奏中的真实时值。乐谱工作台会自动估算速度并量化后渲染五线谱，量化档位可调；如果需要严格可编辑的谱面，导出 MusicXML 用 MuseScore 打开。
- 调号通过简化 Krumhansl–Schmuckler 算法从音高分布估算，谱号根据音域、GM 乐器号和音轨名称判断，结果可能不完全准确。
- 任务数据保存在 `data/jobs/`，重启服务后不会恢复任务列表（音频和结果文件仍在磁盘上）。
- 页面使用本地打包的 [VexFlow](https://vexflow.com/) 渲染五线谱，不依赖 CDN。

## 许可

| 组成 | 许可 | 说明 |
|---|---|---|
| 本项目代码（`server.py`、`web/*.js` 等） | MIT | 见 [LICENSE](LICENSE) |
| 打包的 VexFlow（`web/vendor/vexflow.js`） | MIT | 见 [LICENSE-vexflow.txt](web/vendor/LICENSE-vexflow.txt)，版权归 VexFlow 贡献者所有 |
| dettato 库及其四个模型权重 | Apache-2.0 | 版权归 KobiMusic / Nathan Mills 所有；权重由 dettato 自行下载，不在本仓库内 |

本项目不是 dettato 的 fork，也不修改其代码；仅通过 pip 依赖调用。模型权重的训练数据包含若干 CC BY 4.0 数据集，以及部分仅限非商业研究用途的数据集（详见各模型的 Hugging Face 卡片），如有商业使用需求请自行评估。
