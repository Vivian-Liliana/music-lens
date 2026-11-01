# music-lens · 让模型"读"一首歌

2026-11-01 搭建并验证。输入一个音频文件，输出五样东西：**歌词+时间轴、响度曲线、音色亮度、调性/速度、段落结构**。

不需要人耳，也不需要联网（模型已下到本地）。给纯文本的模型用：把声音变成它能读的数字和图。

> **第一次用？看 [`docs/新手操作指南.md`](docs/新手操作指南.md)** —— 面向完全没写过代码的人，
> 三步装好，七个坑都写在里面。
> 要做视频/图文分享的话，[`docs/发布文案.md`](docs/发布文案.md) 里有标题、简介和口播稿。

```bash
npm i -g music-lens        # 或者 git clone 后 npm i -g .
music-lens setup           # 装 python 依赖 + 下模型（约 2 GB）
music-lens analyze song.mp3
```

第一次会提示没有 python，`setup` 会给出 winget 命令自己装。

## CLI（推荐入口）

这是一个 npm 包形状的目录，带 `bin`。三个命令：

```powershell
$node = "C:\Users\86173\Documents\deepseek-harness\default-workspace\snowluma\SnowLuma-v2.2.1\node.exe"
& $node .\bin\music-lens.mjs doctor                       # 体检：python / 依赖 / 模型
& $node .\bin\music-lens.mjs separate "song.mp3"          # 分轨
& $node .\bin\music-lens.mjs analyze "song.mp3" --model medium
```

`setup` 会自己装 python 依赖并从 hf-mirror 下模型，**默认只下 small（461 MB）**：

```powershell
& $node .\bin\music-lens.mjs setup              # small，约 500 MB 依赖 + 461 MB 模型
& $node .\bin\music-lens.mjs setup --models medium   # 中文效果更好，再下 1.46 GB
```

跨平台：Windows 用 `winget`，macOS 用 `brew`，Linux 用 `apt-get`；
都不行时会打印手工安装命令，也可以用 `MUSIC_LENS_PYTHON` 直接指定解释器路径。

模型和缓存默认放 `~/.music-lens`，可用 `MUSIC_LENS_HOME` 覆盖。

> 本机注意：**node 不在 PATH 里，也没有 npm**，所以 `npx music-lens` 目前跑不了，
> 必须用上面那个完整路径的 node。想让它变成真正的 `npx` 包，需要先
> `winget install OpenJS.NodeJS.LTS`，再 `npm i -g .`。

## 一条命令

```powershell
cd C:\Users\86173\Documents\deepseek-harness\default-workspace\music-lens
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run.ps1 -Audio "C:\path\to\song.mp3"
```

默认用 `small` 模型。要质量就加 `-Model medium`（推荐），路径写模型目录：

```powershell
... -Model "C:\Users\86173\Documents\deepseek-harness\default-workspace\music-lens\models\faster-whisper-medium"
```

## 完整流程（推荐，唱歌必须这么做）

伴奏会把人声糊掉，**先分轨再识别**，效果差一个量级。

```powershell
$py = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
$base = "C:\Users\86173\Documents\deepseek-harness\default-workspace\music-lens"

# 1. 分轨（人声 / 伴奏），约 2.4 倍速
& $py -m demucs --two-stems=vocals -n htdemucs -o "$base\out\stems" "song.mp3"

# 2. 识别人声轨
& $py "$base\scripts\analyze.py" "$base\out\stems\htdemucs\song\vocals.wav" `
   --model "$base\models\faster-whisper-medium" --out "$base\out\song"
```

## 输出文件

| 文件 | 内容 |
|---|---|
| `00_summary.md` | 人读版：时长、BPM、调性、亮度、段落、逐句歌词 |
| `01_lyrics.txt` | 纯歌词 + `[mm:ss]` 时间轴 |
| `02_transcript.json` | 原始分段（含起止秒数） |
| `03_features.csv` | 逐帧 RMS / 频谱质心 / 滚降 / onset，可自己画图算 |
| `04_energy.png` | 三轨图：波形、响度（dB）、亮度（Hz），橙色=高能段，蓝色=安静段 |
| `05_summary.json` | 上面所有指标的结构化版本 |

## 实测结果（这台机器，Ryzen 7 8845H / 16 线程 / 无独显）

| 素材 | 结果 |
|---|---|
| 纯语音（某段语音，6.8 分钟） | ✅ 40 句、707 字，几乎无错，**2 分钟左右出结果** |
| 录音室歌曲（某英文歌曲，4.6 分钟，英文） | ✅ 分轨后 26 句连贯歌词，verse/chorus/bridge 结构清晰 |
| 合唱录音（某合唱录音，62 秒） | ❌ 文字基本不可用，且出现「作詞 李宗盛」这类字幕幻觉 |

结论：**唱歌能做，但强依赖音源质量**。录音室作品分轨后可用；现场录音、合唱、混响重的，会退化成瞎猜。

## 已知限制

- **混响重 / 合唱 / 音质差 → 一定不行**，再怎么调模型也救不回来。
- 器乐段落模型会硬编出句子（幻觉），已加"连续重复行合并"，但不彻底。
- 中文歌会混出繁体，已用 `opencc` 转简体；英文歌务必加 `--lang auto`，否则会被硬翻成中文。
- 调性估算对电子乐、离调多的歌不准（相关系数 < 0.5 基本可以不信）。
- `section` 是按响度粗分的，不等于真实的曲式（主歌/副歌）。

## 环境（已装好，别重复装）

| 东西 | 位置 / 版本 |
|---|---|
| Python | `%LOCALAPPDATA%\Programs\Python\Python312\python.exe`（3.12.10，winget 装的用户级） |
| faster-whisper | 1.2.1 |
| librosa | 1.0.0 |
| demucs | 4.1.0（+ torch 2.15.0+cpu） |
| 模型 small | `models\faster-whisper-small`（461 MB） |
| 模型 medium | `models\faster-whisper-medium`（1.46 GB） |
| ffmpeg | `~\.dsh\bili-whale\bin\ffmpeg.exe`（2018 老版本，够用） |

## 踩过的坑

1. **huggingface.co 被墙**，`hf-mirror.com` 可用。但新版 `hf-xet` 传输层对着镜像会 401，
   必须 `HF_HUB_DISABLE_XET=1` 并手动按 URL 下载（见 `scripts\get-model.ps1`）。
2. **清华 PyPI 镜像返回 403**，只能用官方源。
3. **PyAV 19 删了 `metadata_errors` 参数**，faster-whisper 1.2.1 直接崩。
   绕法：自己用 librosa 解码成 16 kHz numpy 数组再喂给模型（已写进 analyze.py）。
4. **`initial_prompt` 会被复述成歌词**（模型对着音乐段"念提示词"），所以不要传提示词。
5. **`--lang zh` 会把英文歌硬翻成中文**，出乱码。默认改成了 `auto`。
6. VAD 在音乐上会把人声整段滤掉，所以默认关闭（语音场景再加 `--vad`）。
7. **Windows 上 npm 生成的 `music-lens.ps1` 会被执行策略拦住**，敲 `music-lens` 直接报
   `禁止运行脚本`。两个办法：删掉那个 `.ps1`（PowerShell 会回落到 `.cmd`），或者
   `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。**每次 `npm i -g` 之后都要处理一次。**

## 还能往上走

- [ ] **下次先做**：测日文 / 韩文 / 俄文。要下 `large-v3`（3 GB，CPU 上约 medium 的 4 倍慢），
      路径 `models\faster-whisper-large-v3`，命令 `get-model.ps1 -Name large-v3`。
      日文预期最好，韩文次之，俄文中等偏上。藏语不要用 Whisper，要另找 ModelScope 上的专用模型。
- [ ] 加"翻译成中文"这一步（Whisper 只能译英文，中文要转写完再翻）
- [ ] 加 `basic-pitch` 出 MIDI，做旋律线/简谱
- [ ] 用 `librosa.pyin` 出逐帧基频，画"音高随时间的走向"
- [ ] 情绪的 arousal 维度（能量+亮度已经能算个大概）
- [ ] 换 `large-v3`（3 GB，CPU 上慢约 4 倍，中文应该更准）

---

## 致谢

这个包的代码、文档、测试，以及下面那七条踩坑记录，全部由 **DSH（DeepSeek Harness）里的 AI 助手**
在 2026-11-01 的一次会话中完成（模型 `deepseek-flash`）。

它不能拥有账号、不能发布 npm 包、也不能处理 issue——所以仓库和包的所有权、维护责任在人类这边。
这份致谢记录的是“谁写的”，不是转移责任。

过程中被人类纠正过两次重要判断：先说“情绪和歌词做不出来”（错的，歌词能做），
又说“节点不在 PATH 就装不了”（也是错的）。所以文档里那些边界条件，有一半是吵出来的。

