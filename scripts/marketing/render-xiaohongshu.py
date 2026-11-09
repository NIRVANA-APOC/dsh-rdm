#!/usr/bin/env python
"""Render the 小红书 image set for dsh-rdm.

8 pages, 1080 x 1440 (3:4): necessity -> story -> category map -> UI -> install.
Pure Pillow composition from the real repo screenshots; no browser, no network.

Design system (one set across all pages):
  paper #F6F7F8 · ink #14161A · muted #6B7178 · line #D9DDE2 · accent #4D6BFE
  dark pages: #0E1013 / #F2F4F7 / #969C A5 / #2C3037
  type: HarmonyOS Sans SC + Cascadia Mono; margin 96; body 34-36; headline 60-104
"""
from __future__ import annotations

import pathlib
import re

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[2]
SHOTS = ROOT / "assets" / "screenshots"
OUT = ROOT / "assets" / "marketing" / "xiaohongshu"
BADGE = ROOT / "assets" / "marketing" / "powered-by-dsh.png"  # 121x20 official badge

W, H = 1080, 1440
M = 96

INK = (20, 22, 26)
PAPER = (246, 247, 248)
MUTED = (107, 113, 120)
LINE = (217, 221, 226)
ACC = (77, 107, 254)
CORAL = (214, 112, 106)

BG_D = (14, 16, 19)
FG_D = (242, 244, 247)
MUT_D = (150, 156, 165)
LINE_D = (44, 48, 55)
DIM_D = (120, 126, 135)

FONT_DIR = pathlib.Path(r"C:\Windows\Fonts")


def f(path, size):
    return ImageFont.truetype(str(FONT_DIR / path), size)


def H1(s): return f("HarmonyOS_Sans_SC_Bold.ttf", s)
def MED(s): return f("HarmonyOS_Sans_SC_Medium.ttf", s)
def REG(s): return f("HarmonyOS_Sans_SC_Regular.ttf", s)
def MONO(s): return f("CascadiaMono.ttf", s)


BREAK_BEFORE = "，。、；：？！）」』】》,.;:?!)]}%"
TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/+\-–]*")


def tokens(text):
    out, i = [], 0
    while i < len(text):
        m = TOKEN.match(text, i)
        if m:
            out.append(m.group(0))
            i = m.end()
        else:
            out.append(text[i])
            i += 1
    return out


def wrap(draw, text, font, maxw):
    lines, cur = [], ""
    for tok in tokens(text):
        trial = cur + tok
        if draw.textlength(trial, font=font) <= maxw or not cur:
            cur = trial
        elif tok in BREAK_BEFORE:
            cur = trial
            lines.append(cur)
            cur = ""
        else:
            lines.append(cur)
            cur = tok
    if cur:
        lines.append(cur)
    return lines


def text_block(draw, xy, text, font, fill, maxw, lh):
    x, y = xy
    for para in text.split("\n"):
        for line in wrap(draw, para, font, maxw):
            draw.text((x, y), line, font=font, fill=fill, anchor="la")
            y += lh
    return y


def asset(name):
    return Image.open(SHOTS / name).convert("RGB")


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius, fill=255)
    return m


def place_shot(canvas, shot, xy, box_w, radius=16, border=LINE, fade=None):
    iw, ih = shot.size
    new = (box_w, round(ih * box_w / iw))
    img = shot.resize(new, Image.Resampling.LANCZOS)
    mask = rounded_mask(new, radius)
    x, y = xy
    canvas.paste(img, (x, y), mask)
    if fade:
        color, fh = fade
        grad = Image.new("L", (new[0], fh), 0)
        gd = ImageDraw.Draw(grad)
        for i in range(fh):
            gd.line((0, i, new[0], i), fill=round(255 * (i / (fh - 1)) ** 1.15))
        sub = mask.crop((0, new[1] - fh, new[0], new[1]))
        canvas.paste(Image.new("RGB", (new[0], fh), color), (x, y + new[1] - fh),
                     ImageChops.multiply(grad, sub))
    ImageDraw.Draw(canvas).rounded_rectangle(
        (x, y, x + new[0] - 1, y + new[1] - 1), radius, outline=border, width=2
    )
    return new


def rail(draw, x, y, w, h, base, done, gap=None, bg=(0, 0, 0)):
    r = h // 2
    draw.rounded_rectangle((x, y, x + w, y + h), r, fill=base)
    if gap is None:
        draw.rounded_rectangle((x, y, x + w, y + h), r, fill=done)
        return None
    gstart, gw = gap
    gx = x + int(w * gstart)
    draw.rounded_rectangle((x, y, gx, y + h), r, fill=done)
    draw.rectangle((gx, y - 8, gx + gw, y + h + 8), fill=bg)
    return gx, gw


def shadow_card(canvas, xy, size, radius=26, bg=(255, 255, 255), border=LINE):
    x, y = xy
    lay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(lay).rounded_rectangle(
        (x + 4, y + 10, x + size[0] - 4, y + size[1] + 10), radius, fill=(18, 24, 40, 30)
    )
    canvas.alpha_composite(lay.filter(ImageFilter.GaussianBlur(14)))
    ImageDraw.Draw(canvas).rounded_rectangle(
        (x, y, x + size[0], y + size[1]), radius, fill=bg, outline=border, width=2
    )


# ---------------------------------------------------------------- 01 necessity
def page_necessity():
    c = Image.new("RGBA", (W, H), BG_D + (255,))
    d = ImageDraw.Draw(c)

    d.text((M, 112), "dsh-rdm", font=MONO(34), fill=FG_D, anchor="la")
    d.text((M, 168), "DeepSeek Harness 的下载插件", font=REG(30), fill=MUT_D, anchor="la")

    d.text((M, 262), "DSH 没有下载器", font=H1(100), fill=FG_D, anchor="la")
    d.text((M, 386), "AI 只好 curl", font=H1(100), fill=ACC, anchor="la")

    rows = [
        "断线就从 0 开始，进度不落盘",
        "一条连接硬扛，大文件只能等",
        "下完对不对，没人替你校验",
    ]
    y = 548
    for r in rows:
        d.rectangle((M, y + 14, M + 18, y + 17), fill=(104, 110, 120))
        d.text((M + 36, y), r, font=REG(34), fill=MUT_D, anchor="la")
        y += 62

    d.line((M, 742, W - M, 742), fill=LINE_D, width=2)

    # category stat: 7 download plugins in the DSH catalog, 4 need an outside engine
    d.text((M, 776), "7", font=H1(88), fill=FG_D, anchor="la")
    d.text((M + 78, 812), "个下载类插件", font=REG(28), fill=MUT_D, anchor="la")
    x2 = M + 430
    d.text((x2, 776), "4", font=H1(88), fill=ACC, anchor="la")
    d.text((x2 + 78, 812), "个要另装引擎", font=REG(28), fill=MUT_D, anchor="la")
    d.text((M, 900), "aria2c / Rayburst / Gopeed / qBittorrent", font=MONO(26), fill=DIM_D, anchor="la")

    d.text((M, 976), "dsh-rdm：一个 Rust 常驻内核，替掉 curl", font=MED(34), fill=ACC, anchor="la")

    # signature: the same two rails the whole set is built on, curled small
    rail(d, M, 1122, 300, 14, LINE_D, (150, 156, 165), gap=(0.62, 26), bg=BG_D)
    d.text((M + 316, 1114), "curl：断了就没了", font=REG(26), fill=MUT_D, anchor="la")
    sx = M + int(300 * 0.62)
    rail(d, M, 1188, 300, 14, ACC, ACC)
    d.rectangle((sx - 1, 1188 - 8, sx + 1, 1188 + 22), fill=BG_D)
    d.text((M + 316, 1180), "dsh-rdm：接着下", font=REG(26), fill=ACC, anchor="la")

    d.text((M, H - M), "MIT OR Apache-2.0", font=MONO(24), fill=MUT_D, anchor="lb")
    return c.convert("RGB")


# ---------------------------------------------------------------- 02 story
def page_pain():
    c = Image.new("RGBA", (W, H), PAPER + (255,))
    d = ImageDraw.Draw(c)

    d.text((M, 128), "然后我让 AI 下了个 4 GB 的权重", font=REG(32), fill=MUTED, anchor="la")

    d.text((M, 232), "92%", font=MONO(188), fill=INK, anchor="la")
    w92 = d.textlength("92%", font=MONO(188))
    d.text((M + w92 + 36, 292), "→ 0", font=MONO(96), fill=ACC, anchor="la")

    d.text((M, 520), "网抖了一下，从 0 开始", font=H1(60), fill=INK, anchor="la")
    text_block(d, (M, 622), "第二次跑到 87%，我手滑点了暂停——还是从 0。两次都不是网的问题。",
               REG(36), MUTED, W - 2 * M, 58)

    ry = 812
    gx, _ = rail(d, M, ry, W - 2 * M, 22, (226, 229, 233), (150, 156, 165),
                 gap=(0.62, 44), bg=PAPER)
    d.line((gx + 22, ry - 34, gx + 22, ry + 52), fill=CORAL, width=3)
    d.text((M, ry + 46), "断在这里", font=REG(26), fill=MUTED, anchor="la")
    d.text((gx + 16, ry + 46), "状态没落盘", font=REG(26), fill=CORAL, anchor="la")

    d.text((M, 976), "问题不在网", font=H1(52), fill=INK, anchor="la")
    text_block(d, (M, 1064), "在 curl 只活一次：进程结束，进度和字节区间一起消失。",
               REG(36), MUTED, W - 2 * M, 58)

    d.text((W - M, H - M), "dsh-rdm", font=MONO(24), fill=(162, 167, 174), anchor="rb")
    return c.convert("RGB")


# ---------------------------------------------------------------- 03 category
def page_picker():
    c = Image.new("RGBA", (W, H), PAPER + (255,))
    d = ImageDraw.Draw(c)
    d.text((M, 128), "社区插件目录里，下载类已经有 7 个", font=REG(32), fill=MUTED, anchor="la")
    d.text((M, 196), "换哪个都行", font=H1(64), fill=INK, anchor="la")
    d.text((M, 280), "先看这三条", font=H1(64), fill=ACC, anchor="la")

    items = [
        ("外挂依赖", "7 个里有 4 个要先装 aria2c、Rayburst、Gopeed 或 qBittorrent。"),
        ("续传证据", "dsh-rdm 把续传跑成 14/14 场景、241/241 断言，含跨内核重启续传。"),
        ("安装成本", "dsh-rdm 五平台预编译，没有额外运行时，安装过程不跑 cargo。"),
    ]
    y = 452
    for i, (head, body) in enumerate(items):
        d.line((M, y, W - M, y), fill=LINE, width=2)
        d.text((M, y + 40), head, font=MED(34), fill=INK, anchor="la")
        text_block(d, (M + 250, y + 34), body, REG(32), MUTED, W - 2 * M - 260, 52)
        y += 210

    d.line((M, y, W - M, y), fill=LINE, width=2)
    d.text((M, y + 30), "来源：dsh-plugin-catalog（9412 条）+ 各插件 README，2026-11-06",
           font=REG(24), fill=(150, 155, 162), anchor="la")

    d.text((M, 1216), "它不一定样样都强", font=MED(32), fill=INK, anchor="la")
    d.text((M, 1274), "但这三条，图上都写了出处。", font=REG(30), fill=MUTED, anchor="la")
    return c.convert("RGB")



# ---------------------------------------------------------------- mixed-script text
ASCII_RUN = re.compile(r"[A-Za-z0-9._/+\-%–× ]+")


def draw_mixed(draw, xy_baseline, text, mono_size, cjk_size, fill, cjk_fill=None):
    """Draw mono for ASCII runs and HarmonyOS for CJK, aligned on one baseline."""
    cjk_fill = fill if cjk_fill is None else cjk_fill
    fm, fc = MONO(mono_size), REG(cjk_size)
    x, y = xy_baseline
    pos = 0
    while pos < len(text):
        m = ASCII_RUN.match(text, pos)
        if m:
            chunk, font, colour = m.group(0), fm, fill
            pos = m.end()
        else:
            end = pos
            while end < len(text) and not ASCII_RUN.match(text, end):
                end += 1
            chunk, font, colour = text[pos:end], fc, cjk_fill
            pos = end
        draw.text((x, y), chunk, font=font, fill=colour, anchor="ls")
        x += draw.textlength(chunk, font=font)
    return x


# ---------------------------------------------------------------- 03 rust kernel
def page_rust():
    c = Image.new("RGBA", (W, H), PAPER + (255,))
    d = ImageDraw.Draw(c)
    d.text((M, 128), "Rust 写的，按 DSH 的进程模型设计", font=REG(32), fill=MUTED, anchor="la")
    d.text((M, 192), "不是给 curl 套层壳", font=H1(64), fill=INK, anchor="la")
    d.text((M, 276), "是自己写了个内核", font=H1(64), fill=ACC, anchor="la")
    d.text((M, 384), "轻量不是形容词——下面每一行都能被验证。", font=REG(32), fill=MUTED, anchor="la")

    rows = [
        ("实现语言", "Rust", "无 GC、无运行时"),
        ("内核体积", "4.39 MiB", "静态二进制，随插件分发"),
        ("空闲常驻", "5.7–6.7 MiB", "闲置时只占这一点内存"),
        ("进程模型", "1 个进程", "懒启动，随 DSH 退出"),
        ("对外接口", "stdio", "NDJSON，没有监听端口"),
        ("预编译平台", "5 个平台", "Win / Linux / macOS，安装不跑 cargo"),
    ]
    y = 486
    for label, value, note in rows:
        d.line((M, y, W - M, y), fill=LINE, width=2)
        d.text((M, y + 40), label, font=REG(28), fill=MUTED, anchor="la")
        draw_mixed(d, (M + 240, y + 62), value, 44, 34, INK)
        d.text((M + 240, y + 88), note, font=REG(25), fill=(140, 145, 152), anchor="la")
        y += 142
    d.line((M, y, W - M, y), fill=LINE, width=2)

    d.text((M, y + 34), "实测口径见 docs/verification.md；体积与内存随平台略有差异。",
           font=REG(23), fill=(150, 155, 162), anchor="la")
    return c.convert("RGB")


# ---------------------------------------------------------------- 04 adaptive concurrency
def page_aimd():
    c = Image.new("RGBA", (W, H), BG_D + (255,))
    d = ImageDraw.Draw(c)
    d.text((M, 128), "每秒评估一次，连接数自己上下", font=REG(32), fill=MUT_D, anchor="la")
    d.text((M, 192), "不是一次拉满", font=H1(64), fill=FG_D, anchor="la")
    d.text((M, 276), "是边走边调", font=H1(64), fill=ACC, anchor="la")

    # ---- step chart of the connection target over 12 one-second windows
    x0, x1 = M, W - M
    top, bottom = 452, 780
    lo, hi = 0, 10
    marks = [4, 8, 12]
    for m in marks:
        gy = bottom - (m - lo) / (hi - lo) * (bottom - top)
        d.line((x0, gy, x1, gy), fill=(32, 36, 43), width=1)
        d.text((x0 - 8, gy - 12), str(m), font=MONO(20), fill=(96, 102, 111), anchor="ra")
    d.line((x0, bottom, x1, bottom), fill=LINE_D, width=2)

    # target over time (seconds): ramp, 429 at t=5 halves it, then ramp again, then a dip
    steps = [(0, 8), (1, 9), (2, 10), (3, 11), (4, 12), (5, 6),
             (6, 7), (7, 8), (8, 9), (9, 10), (10, 10), (11, 9), (12, 9)]
    span = 12.0
    pts = []
    for t, v in steps:
        px = x0 + t / span * (x1 - x0)
        py = bottom - (v - lo) / (hi - lo) * (bottom - top)
        pts.append((px, py))
    for i in range(len(pts) - 1):
        ax, ay = pts[i]
        bx, by = pts[i + 1]
        d.line((ax, ay, bx, ay), fill=ACC, width=4)
        d.line((bx, ay, bx, by), fill=ACC, width=4)

    # markers: vertical rules stay in the plot, captions move under the axis
    mx, my = pts[5]
    d.line((mx, my - 18, mx, bottom), fill=CORAL, width=2)
    d.text((mx, bottom + 16), "429 → 目标砍半", font=REG(25), fill=CORAL, anchor="ma")
    dx, dy = pts[11]
    d.line((dx, dy - 14, dx, bottom), fill=(150, 156, 165), width=2)
    d.text((dx, bottom + 16), "吞吐掉 30% → 减一", font=REG(25), fill=MUT_D, anchor="ma")
    d.text((x0, bottom + 52), "每次调整一个 1 秒窗口；图上是一个任务的自适应轨迹",
           font=REG(23), fill=(96, 102, 111), anchor="la")

    # ---- the four rules
    rules = [
        ("+1", "吞吐没掉，且连接吃满 75% 以上", (150, 156, 165)),
        ("÷2", "收到 429 / 503 的 Retry-After", CORAL),
        ("−1", "吞吐比上一个窗口掉 30%", (150, 156, 165)),
        ("上限", "min(你设的 1–32, 剩余块数)", (150, 156, 165)),
    ]
    y = 900
    for tag, text, color in rules:
        draw_mixed(d, (M, y), tag, 30, 30, CORAL if tag == "÷2" else ACC)
        d.text((M + 130, y - 30), text, font=REG(30), fill=color, anchor="la")
        y += 56

    d.text((M, 1112), "同一个控制器还管尾部窃取：最慢那块会被劈开，让闲着的连接接走。",
           font=REG(28), fill=MUT_D, anchor="la")

    d.text((M, 1180), "回环多连接吞吐", font=REG(34), fill=MUT_D, anchor="la")
    w_lbl = d.textlength("回环多连接吞吐", font=REG(34))
    d.text((M + w_lbl + 18, 1182), "109–145 MiB/s", font=MONO(38), fill=ACC, anchor="la")
    d.text((M, 1238), "单次测量、机器相关；14/14 个 e2e 场景覆盖多连接与退避", font=REG(24), fill=(120, 126, 135), anchor="la")
    return c.convert("RGB")


# ---------------------------------------------------------------- 05 light panel
def page_light_panel():
    c = Image.new("RGBA", (W, H), PAPER + (255,))
    d = ImageDraw.Draw(c)
    d.text((M, 128), "一块面板，看完全部任务", font=REG(32), fill=MUTED, anchor="la")
    d.text((M, 192), "不等它下完", font=H1(64), fill=INK, anchor="la")
    d.text((M, 276), "也知道它在干什么", font=H1(64), fill=ACC, anchor="la")

    place_shot(c, asset("panel-light.png"), (M, 424), W - 2 * M, fade=(PAPER, 110))

    cols = [
        ("状态与速度", "百分比、速度、ETA\n只在跑的时候出现"),
        ("连接轨道", "一条 tick 一个连接\n跑着的才呼吸"),
        ("逐行操作", "暂停 继续 重试\n取消 移除 复制路径"),
    ]
    y0 = 1146
    cw = (W - 2 * M) // 3
    for i, (head, body) in enumerate(cols):
        x = M + i * cw
        if i:
            d.line((x - 30, y0, x - 30, y0 + 168), fill=LINE, width=2)
        d.rectangle((x, y0, x + 26, y0 + 3), fill=ACC)
        d.text((x, y0 + 22), head, font=MED(32), fill=INK, anchor="la")
        text_block(d, (x, y0 + 74), body, REG(26), MUTED, cw - 52, 40)
    return c.convert("RGB")


# ---------------------------------------------------------------- 05 dark panel
def page_dark_panel():
    c = Image.new("RGBA", (W, H), BG_D + (255,))
    d = ImageDraw.Draw(c)
    d.text((M, 128), "主题、字体、圆角都来自宿主", font=REG(32), fill=MUT_D, anchor="la")
    d.text((M, 192), "深色模式下", font=H1(64), fill=FG_D, anchor="la")
    d.text((M, 276), "是同一块面板", font=H1(64), fill=ACC, anchor="la")

    place_shot(c, asset("panel-dark.png"), (M, 424), W - 2 * M, border=LINE_D, fade=(BG_D, 110))

    text_block(d, (M, 1150), "面板只消费宿主的主题 token，没有一条自绘色值。切浅色、深色、大字号，它跟着变。",
               REG(34), MUT_D, W - 2 * M - 60, 56)
    return c.convert("RGB")


# ---------------------------------------------------------------- 06 details
def page_details():
    c = Image.new("RGBA", (W, H), PAPER + (255,))
    d = ImageDraw.Draw(c)
    d.text((M, 128), "任务详情里能看到的", font=REG(32), fill=MUTED, anchor="la")
    d.text((M, 192), "续传、校验、重试", font=H1(64), fill=INK, anchor="la")
    d.text((M, 276), "每一步都有记录", font=H1(64), fill=ACC, anchor="la")

    place_shot(c, asset("panel-details.png"), (M, 424), W - 2 * M, fade=(PAPER, 110))

    items = [
        ("来源与保存路径", "原始 URL、最终 URL、落地文件"),
        ("分片与续传", "分片大小、已续传块数、耗时"),
        ("SHA-256", "通过才原子改名，失败不动目标"),
        ("内核事件日志", "有界输出，出问题能追到哪一步"),
    ]
    y = 1130
    for i, (k, v) in enumerate(items):
        col, row = i % 2, i // 2
        x = M + col * ((W - 2 * M) // 2)
        yy = y + row * 98
        d.rectangle((x, yy + 12, x + 16, yy + 16), fill=ACC)
        d.text((x + 30, yy), k, font=MED(30), fill=INK, anchor="la")
        d.text((x + 30, yy + 44), v, font=REG(25), fill=MUTED, anchor="la")
    return c.convert("RGB")


# ---------------------------------------------------------------- 07 mobile
def page_mobile():
    c = Image.new("RGBA", (W, H), PAPER + (255,))
    d = ImageDraw.Draw(c)
    d.text((M, 128), "窄屏不是砍功能", font=REG(32), fill=MUTED, anchor="la")

    d.text((M, 200), "窄到 520 px", font=H1(64), fill=INK, anchor="la")
    d.text((M, 284), "也不挤文件名", font=H1(64), fill=ACC, anchor="la")

    text_block(d, (M, 396), "逐行图标操作折叠进菜单，状态和连接轨道都留着。",
               REG(32), MUTED, 448, 52)

    shot = asset("panel-mobile.png")
    box_w = 424
    shot_h = int(shot.size[1] * box_w / shot.size[0])
    shadow_card(c, (576, 176), (box_w + 24, shot_h + 24), radius=28, bg=(255, 255, 255))
    place_shot(c, shot, (588, 188), box_w, radius=20, fade=(PAPER, 110))

    d.text((M, 812), "顺序也没变", font=MED(30), fill=INK, anchor="la")
    text_block(d, (M, 866), "状态 → 文件名 → 百分比 → 字节轨道，一行读下来还是同一条流水账。",
               REG(27), MUTED, 420, 46)
    d.text((W - M, H - M), "dsh-rdm", font=MONO(24), fill=(162, 167, 174), anchor="rb")
    return c.convert("RGB")


# ---------------------------------------------------------------- 08 install
def page_install():
    c = Image.new("RGBA", (W, H), BG_D + (255,))
    d = ImageDraw.Draw(c)
    d.text((M, 128), "五个平台都是预编译", font=REG(32), fill=MUT_D, anchor="la")
    d.text((M, 192), "装一行，不碰 Rust", font=H1(64), fill=FG_D, anchor="la")

    d.rounded_rectangle((M, 316, W - M, 316 + 128), 16, fill=(20, 23, 28), outline=LINE_D, width=2)
    d.text((M + 32, 316 + 28), "dsh plugin --profile web add dsh-rdm", font=MONO(32), fill=FG_D, anchor="la")
    d.text((M + 32, 316 + 80), "装完刷新页面，左侧栏出现下载入口", font=REG(26), fill=MUT_D, anchor="la")

    d.text((M, 512), "先看证据，再决定装不装", font=MED(34), fill=FG_D, anchor="la")
    stats = [("14/14", "内核 e2e 场景"), ("241/241", "断言"),
             ("4.39 MiB", "内核二进制"), ("5.7–6.7 MiB", "空闲常驻内存")]
    for i, (num, label) in enumerate(stats):
        col, row = i % 2, i // 2
        x = M + col * ((W - 2 * M) // 2)
        y = 592 + row * 164
        d.text((x, y), num, font=MONO(56), fill=ACC, anchor="la")
        d.text((x, y + 76), label, font=REG(28), fill=MUT_D, anchor="la")

    d.line((M, 972, W - M, 972), fill=LINE_D, width=2)
    text_block(
        d, (M, 1014),
        "边界：只吃 HTTP/1.1 源站；完整 e2e 只在 Windows x64 与 Linux x64 跑过，"
        "macOS 与 Linux arm64 是原生 CI 构建加冒烟。回环多连接吞吐 109–145 MiB/s，单次、机器相关。",
        REG(26), (128, 134, 143), W - 2 * M, 44,
    )

    d.text((M, H - M), "MIT OR Apache-2.0", font=MONO(24), fill=MUT_D, anchor="lb")
    badge = Image.open(BADGE).convert("RGBA")
    c.alpha_composite(badge, (W - M - 121, H - M - 20))
    return c.convert("RGB")


PAGES = [
    ("01-necessity", page_necessity),
    ("02-pain", page_pain),
    ("03-rust", page_rust),
    ("04-adaptive", page_aimd),
    ("05-panel-light", page_light_panel),
    ("06-panel-dark", page_dark_panel),
    ("07-details", page_details),
    ("08-mobile", page_mobile),
    ("09-install", page_install),
]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in PAGES:
        img = fn()
        path = OUT / f"{name}.png"
        img.save(path, "PNG", optimize=True)
        print(f"{path.name}\t{img.size[0]}x{img.size[1]}\t{path.stat().st_size // 1024} KiB")


if __name__ == "__main__":
    main()
