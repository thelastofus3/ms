"""Regenerate documentation diagrams. Python stdlib; --png additionally needs Pillow.

The page definitions below are the generator's source of truth. Drawing manual
changes directly in draw.io requires exporting the corresponding SVGs there.
"""

from __future__ import annotations

import argparse
import html
import textwrap
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WIDTH, HEIGHT = 1600, 1080
COLORS = {
    "client": ("#e7f0ff", "#3469ba"),
    "service": ("#e6f4ee", "#268360"),
    "data": ("#fff1d8", "#b98026"),
    "physical": ("#eeeaf8", "#8062b3"),
    "warning": ("#ffebe5", "#bb5941"),
}


def node(key, title, detail, x, y, kind="service", width=280, height=112):
    return dict(id=key, title=title, detail=detail, x=x, y=y, w=width, h=height, kind=kind)


def edge(source, target, label="", a="E", b="W", via=(), label_at=None, both=False):
    return dict(source=source, target=target, label=label, a=a, b=b,
                via=list(via), label_at=label_at, both=both)


PAGES = [
    dict(id="components", title="01 · Компоненты и потоки данных",
         subtitle="Долгая генерация ресурсов отделена от поз в реальном времени и от видеоконференции.",
         footer="REST — задания и ресурсы • WebSocket — состояние и позы • WebRTC — аудио, видео и демонстрация экрана",
         nodes=[
             node("capture", "Фото / видео комнаты", "Съёмка с разных точек", 60, 160, "physical"),
             node("space", "Space Service", "Python · COLMAP · Splatfacto", 410, 160),
             node("profile", "Данные человека", "Фото-эталоны + профиль", 60, 330, "physical"),
             node("avatar", "Avatar Service", "Python · Blender · MPFB", 410, 330),
             node("assets", "Пакеты ресурсов", "Версии · манифесты · файлы", 800, 245, "data"),
             node("platform", "Platform", "Java · встречи · назначения", 800, 465),
             node("web", "Web-клиент", "React · Three.js · Spark", 1220, 465, "client"),
             node("camera", "Камера комнаты", "Один фиксированный RGB-поток", 60, 635, "physical"),
             node("tracking", "Tracking Agent", "OpenCV · MediaPipe · SFace", 410, 635),
             node("db", "PostgreSQL", "Состояние и задания сервисов", 800, 650, "data"),
             node("livekit", "LiveKit", "Аудио · видео · screen share", 800, 850),
             node("tv", "Телевизор", "Браузерный клиент экрана", 1220, 850, "client"),
         ],
         edges=[edge("capture", "space"), edge("profile", "avatar"),
                edge("space", "assets", via=[(745,216),(745,301)]),
                edge("avatar", "assets", via=[(770,386),(770,325)]),
                edge("assets", "web", "HTTP: ресурсы", "E", "N", via=[(1360,301)], label_at=(1310,395)),
                edge("platform", "web", "REST / WS", both=True, label_at=(1150,496)),
                edge("camera", "tracking"),
                edge("tracking", "platform", "Позы", via=[(745,691),(745,521)], label_at=(745,606)),
                edge("platform", "db", "", "S", "N"),
                edge("web", "livekit", "WebRTC", "S", "E", via=[(1360,610),(1150,610),(1150,906)], label_at=(1150,770), both=True),
                edge("livekit", "tv", "WebRTC", both=True, label_at=(1150,880))]),
    dict(id="deployment", title="02 · Размещение первого запуска",
         subtitle="Один компьютер: Windows для камеры и клиента; отдельные окружения для серверных и GPU-компонентов.",
         footer="Генерация выполняется до встречи. Перенос worker на другой сервер сохраняет HTTP-контракты и форматы пакетов.",
         groups=[(40,150,1520,710,"Тестовый компьютер · RTX 2060 6 ГБ · RAM ≈ 32 ГБ"),
                 (65,215,480,610,"Windows: клиент и устройства"),
                 (585,215,950,610,"Изолированные серверные окружения / Linux · WSL2")],
         nodes=[
             node("browser", "Web / телевизор", "Браузер · интерактивная сцена", 150, 295, "client"),
             node("camera", "RGB-камера", "Захват локального устройства", 150, 480, "physical"),
             node("agent", "Tracking Agent", "Поза и локальная калибровка", 150, 670),
             node("platform", "Java Platform", "REST · WebSocket", 650, 295),
             node("db", "PostgreSQL", "Отдельные схемы владельцев", 1170, 295, "data"),
             node("space", "Space worker", "GPU · пакетная реконструкция", 650, 485),
             node("avatar", "Avatar worker", "Blender · сборка GLB", 1170, 485),
             node("livekit", "LiveKit", "SFU · медиапотоки", 650, 675),
             node("files", "Хранилище файлов", "Диск через HTTP-адаптеры", 1170, 675, "data"),
             node("remote", "Будущий GPU-сервер", "Те же сервисы и контракты; новое размещение", 650, 900, "physical", 800, 85),
         ],
         edges=[edge("browser", "platform", "HTTP / WS", both=True, label_at=(540,333)),
                edge("platform", "db", "Метаданные", label_at=(1050,333)),
                edge("camera", "agent", "", "S", "N"),
                edge("agent", "platform", "Позы", "E", "S", via=[(575,726),(575,440),(790,440)], label_at=(575,575)),
                edge("space", "files", "Результат", "E", "W", via=[(1060,541),(1060,731)], label_at=(1060,620)),
                edge("avatar", "files", "", "S", "N"),
                edge("browser", "livekit", "WebRTC", "W", "W", via=[(110,351),(110,640),(620,640),(620,731)], label_at=(350,640), both=True)]),
    dict(id="generation", title="03 · Генерация и публикация ресурсов",
         subtitle="Успешное задание создаёт проверенный пакет. Публикация для встречи дополнительно требует подготовки ресурса.",
         footer="Ошибки и отмена не заменяют опубликованную версию. Состояние задания сохраняется в PostgreSQL владельца сервиса.",
         nodes=[
             node("input", "Входные данные", "Комната: фото/видео; человек: профиль", 60, 185, "physical"),
             node("upload", "Проверка загрузки", "Формат · размер · декодирование", 450, 185),
             node("job", "Сохранённое задание", "QUEUED → RUNNING", 840, 185, "data"),
             node("worker", "Генератор", "SpaceGenerator / AvatarGenerator", 1230, 185),
             node("export", "Экспорт результата", "PLY или GLB + метаданные", 1230, 495),
             node("validate", "Проверка пакета", "Файлы · скелет · манифест", 840, 495),
             node("draft", "Скачиваемый пакет", "SUCCEEDED · ресурс DRAFT", 450, 495, "data"),
             node("editor", "Подготовка оператором", "Привязка / разметка / просмотр", 60, 495, "client"),
             node("publish", "Публикация версии", "Неизменяемый ресурс", 60, 800),
             node("catalog", "Каталог Platform", "Закрепление версии на встрече", 450, 800, "data"),
             node("meeting", "Загрузка во встречу", "Повторное использование пакета", 840, 800, "client"),
             node("failure", "Ошибка / отмена", "Диагностика · повтор по запросу", 1230, 800, "warning"),
         ],
         edges=[edge("input","upload"), edge("upload","job"), edge("job","worker"),
                edge("worker","export","","S","N"), edge("export","validate","","W","E"),
                edge("validate","draft","","W","E"), edge("draft","editor","","W","E"),
                edge("editor","publish","","S","N"), edge("publish","catalog"), edge("catalog","meeting"),
                edge("validate","failure","Проверка не пройдена","S","N",via=[(980,715),(1370,715)],label_at=(1230,715))]),
    dict(id="tracking", title="04 · Калибровка, поза и идентичность",
         subtitle="Временный трек камеры, личность участника и ресурс аватара — разные сущности.",
         footer="Одна камера даёт оценку глубины. При перекрытии или конфликте идентичности допустима потеря слежения, но не подмена человека.",
         nodes=[
             node("camera","Кадр камеры","Время захвата · cameraId",60,175,"physical"),
             node("pose","Обнаружение поз","MediaPipe · несколько людей",450,175),
             node("tracks","Сопровождение","Временные trackId",840,175),
             node("face","Кандидат личности","YuNet / SFace · галерея встречи",1230,175),
             node("calib","Калибровка","Объектив · поза камеры · пол",60,495,"data"),
             node("world","Поза в комнате","Метры · Y вверх · уверенность",450,495),
             node("observation","TrackObservation","Источник · версия · поза · кандидат",840,495,"data"),
             node("binding","Назначение Platform","trackId → participantId → avatarId",1230,495),
             node("rig","Адаптер аватара","Общая поза → кости модели",60,805,"client"),
             node("frame","PoseFrame клиентам","Свежие данные · сглаживание",450,805,"data"),
             node("uncertain","UNCERTAIN / LOST","Нет молчаливого переназначения",840,805,"warning"),
             node("operator","Подтверждение","Оператор разрешает конфликт",1230,805,"client"),
         ],
         edges=[edge("camera","pose"),edge("pose","tracks"),edge("tracks","face"),
                edge("pose","world","","S","N"),edge("calib","world"),edge("world","observation"),
                edge("face","binding","","S","N"),edge("observation","binding"),
                edge("binding","uncertain","Нет уверенности","E","E",via=[(1560,551),(1560,975),(1150,975),(1150,861)],label_at=(1390,975)),
                edge("uncertain","operator"),
                edge("operator","binding","Подтвердить","N","S",label_at=(1440,715)),
                edge("binding","frame","Подтверждённая связь","W","N",via=[(1170,551),(1170,690),(590,690)],label_at=(875,690)),
                edge("frame","rig","","W","E")]),
    dict(id="conference", title="05 · Конференция и поверхности экранов",
         subtitle="Медиапотоки и 3D-состояние связаны общим participantId, но передаются независимо.",
         footer="Не снимать телевизор повторно. Не воспроизводить одну аудиодорожку через каждую виртуальную поверхность.",
         nodes=[
             node("remote","Удалённый участник","Аватар + веб-камера + микрофон",80,185,"client"),
             node("platform","Java Platform","Доступ · participantId · токен",650,185),
             node("tv","Физический телевизор","Браузер · выбранный screenId",1220,185,"client"),
             node("virtual","Виртуальный экран","Видеотекстуры тех же потоков",80,505,"client"),
             node("livekit","LiveKit SFU","Камеры · звук · демонстрация",650,505),
             node("audio","Звук комнаты","Один микрофон и аудиовыход",1220,505,"physical"),
             node("avatar","Аватар в 3D-комнате","Независим от включённой камеры",80,815,"client"),
             node("layout","Конфигурация экрана","Сетка участников / демонстрация",650,815,"data"),
             node("status","Состояния медиа","Камера выключена · вышел · offline",1220,815,"warning"),
         ],
         edges=[edge("remote","platform","REST / WS",both=True,label_at=(505,220)),
                edge("platform","tv","Токен экрана",label_at=(1080,220)),
                edge("remote","livekit","WebRTC","S","W",via=[(220,350),(530,350),(530,561)],label_at=(530,410),both=True),
                edge("livekit","virtual","Видео","W","E",label_at=(470,580)),
                edge("livekit","tv","Видео","N","S",via=[(790,415),(1360,415)],label_at=(1080,415)),
                edge("livekit","audio","Аудио",both=True,label_at=(1080,545)),
                edge("layout","livekit","Выбранные потоки","N","S",label_at=(860,720)),
                edge("layout","virtual","Раскладка","W","S",via=[(520,871),(520,735),(220,735)],label_at=(390,735))]),
]


def port(n, side):
    return {"N": (n["x"]+n["w"]/2,n["y"]), "S": (n["x"]+n["w"]/2,n["y"]+n["h"]),
            "E": (n["x"]+n["w"],n["y"]+n["h"]/2), "W": (n["x"],n["y"]+n["h"]/2)}[side]


def points(e, lookup):
    start, end = port(lookup[e["source"]], e["a"]), port(lookup[e["target"]], e["b"])
    if e["via"]:
        return [start, *e["via"], end]
    if start[0] == end[0] or start[1] == end[1]:
        return [start, end]
    return [start, ((start[0]+end[0])/2, start[1]), ((start[0]+end[0])/2, end[1]), end]


def lines(n):
    return textwrap.wrap(n["detail"], width=max(24, int(n["w"]/10)))


def svg(page):
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}">',
             '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#53647c"/></marker></defs>',
             '<rect width="100%" height="100%" fill="#f7f9fc"/>']
    def text(x,y,value,size=20,weight="normal",anchor="start",fill="#223047"):
        parts.append(f'<text x="{x}" y="{y}" font-family="Segoe UI,Arial,sans-serif" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}" fill="{fill}">{html.escape(value)}</text>')
    text(55,65,page["title"],32,"600")
    text(55,108,page["subtitle"],20)
    for x,y,w,h,title in page.get("groups",[]):
        parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16" fill="none" stroke="#c5cfdd" stroke-width="2" stroke-dasharray="8 5"/>')
        text(x+18,y+30,title,20,"600")
    lookup={n["id"]:n for n in page["nodes"]}
    for e in page["edges"]:
        coords=" ".join(f"{x},{y}" for x,y in points(e,lookup))
        start=' marker-start="url(#arrow)"' if e["both"] else ""
        parts.append(f'<polyline points="{coords}" fill="none" stroke="#53647c" stroke-width="2" stroke-linejoin="round" marker-end="url(#arrow)"{start}/>')
    for n in page["nodes"]:
        fill,stroke=COLORS[n["kind"]]
        parts.append(f'<rect x="{n["x"]}" y="{n["y"]}" width="{n["w"]}" height="{n["h"]}" rx="12" fill="{fill}" stroke="{stroke}" stroke-width="2"/>')
        text(n["x"]+n["w"]/2,n["y"]+34,n["title"],21,"600","middle")
        for i,line in enumerate(lines(n)):
            text(n["x"]+n["w"]/2,n["y"]+66+i*24,line,17,"normal","middle")
    for e in page["edges"]:
        if e["label"]:
            pts=points(e,lookup)
            x,y=e["label_at"] or ((pts[0][0]+pts[-1][0])/2,(pts[0][1]+pts[-1][1])/2-12)
            w=len(e["label"])*9.5+16
            parts.append(f'<rect x="{x-w/2}" y="{y-19}" width="{w}" height="26" rx="5" fill="#f7f9fc"/>')
            text(x,y,e["label"],17,anchor="middle")
    text(55,1040,page["footer"],18)
    parts.append('</svg>')
    return '\n'.join(parts)


def drawio():
    doc=ET.Element("mxfile",host="app.diagrams.net",version="24.7.17",type="device")
    anchors={"N":(.5,0),"S":(.5,1),"W":(0,.5),"E":(1,.5)}
    for page in PAGES:
        diagram=ET.SubElement(doc,"diagram",id=page["id"],name=page["title"])
        model=ET.SubElement(diagram,"mxGraphModel",dx="1600",dy="1080",grid="1",gridSize="10",guides="1",tooltips="1",connect="1",arrows="1",fold="1",page="1",pageScale="1",pageWidth=str(WIDTH),pageHeight=str(HEIGHT),math="0",shadow="0")
        root=ET.SubElement(model,"root")
        ET.SubElement(root,"mxCell",id="0")
        ET.SubElement(root,"mxCell",id="1",parent="0")
        def box(key,value,x,y,w,h,style):
            cell=ET.SubElement(root,"mxCell",id=key,value=value,style=style,vertex="1",parent="1")
            ET.SubElement(cell,"mxGeometry",x=str(x),y=str(y),width=str(w),height=str(h),attrib={"as":"geometry"})
        box("title",page["title"],55,25,1490,48,"text;html=0;align=left;fontSize=32;fontStyle=1;fontColor=#223047;")
        box("subtitle",page["subtitle"],55,82,1490,36,"text;html=0;align=left;fontSize=20;fontColor=#223047;")
        box("footer",page["footer"],55,1008,1490,50,"text;html=0;align=left;whiteSpace=wrap;fontSize=18;fontColor=#223047;")
        for i,(x,y,w,h,title) in enumerate(page.get("groups",[])):
            box(f"group{i}",title,x,y,w,h,"rounded=1;fillColor=none;strokeColor=#c5cfdd;dashed=1;verticalAlign=top;align=left;spacing=16;fontSize=20;")
        lookup={n["id"]:n for n in page["nodes"]}
        for n in page["nodes"]:
            fill,stroke=COLORS[n["kind"]]
            value=f'<b>{html.escape(n["title"])}</b><br/><font style="font-size:17px">{html.escape(n["detail"])}</font>'
            box(n["id"],value,n["x"],n["y"],n["w"],n["h"],f"rounded=1;whiteSpace=wrap;html=1;fillColor={fill};strokeColor={stroke};strokeWidth=2;fontColor=#223047;fontFamily=Segoe UI;fontSize=21;spacing=10;")
        for i,e in enumerate(page["edges"]):
            ax,ay=anchors[e["a"]]; bx,by=anchors[e["b"]]
            style=f"edgeStyle=segmentEdgeStyle;rounded=0;html=0;endArrow=block;endFill=1;strokeColor=#53647c;strokeWidth=2;fontSize=17;labelBackgroundColor=#f7f9fc;exitX={ax};exitY={ay};entryX={bx};entryY={by};"
            if e["both"]: style+="startArrow=block;startFill=1;"
            # Labels are separate vertices to preserve the layout in both formats.
            cell=ET.SubElement(root,"mxCell",id=f"edge{i}",value="",style=style,edge="1",parent="1",source=e["source"],target=e["target"])
            geo=ET.SubElement(cell,"mxGeometry",relative="1",attrib={"as":"geometry"})
            pts=points(e,lookup)
            if len(pts)>2:
                array=ET.SubElement(geo,"Array",attrib={"as":"points"})
                for x,y in pts[1:-1]: ET.SubElement(array,"mxPoint",x=str(x),y=str(y))
            if e["label"]:
                x,y=e["label_at"] or ((pts[0][0]+pts[-1][0])/2,(pts[0][1]+pts[-1][1])/2-12)
                w=len(e["label"])*10+22
                box(f"label{i}",e["label"],x-w/2,y-22,w,30,"text;html=0;align=center;verticalAlign=middle;fillColor=#f7f9fc;strokeColor=none;fontSize=17;fontColor=#223047;")
    ET.indent(doc,space="  ")
    return ET.tostring(doc,encoding="unicode",xml_declaration=True)


def png(page, destination):
    """Raster preview of the same layout for local visual QA, not a draw.io export."""
    from PIL import Image, ImageDraw, ImageFont
    import math
    im=Image.new("RGB",(WIDTH,HEIGHT),"#f7f9fc"); d=ImageDraw.Draw(im)
    fonts=Path("C:/Windows/Fonts")
    def font(size,bold=False): return ImageFont.truetype(str(fonts/("segoeuib.ttf" if bold else "segoeui.ttf")),size)
    def text(x,y,value,size=20,bold=False,center=False):
        d.text((x,y),value,font=font(size,bold),fill="#223047",anchor="ms" if center else "ls")
    text(55,65,page["title"],32,True); text(55,108,page["subtitle"])
    for x,y,w,h,title in page.get("groups",[]):
        d.rounded_rectangle((x,y,x+w,y+h),radius=16,outline="#c5cfdd",width=2)
        text(x+18,y+30,title,20,True)
    lookup={n["id"]:n for n in page["nodes"]}
    def arrow(tip,tail):
        angle=math.atan2(tip[1]-tail[1],tip[0]-tail[0]); length=13
        base=(tip[0]-length*math.cos(angle),tip[1]-length*math.sin(angle))
        d.polygon([tip,(base[0]+5*math.sin(angle),base[1]-5*math.cos(angle)),(base[0]-5*math.sin(angle),base[1]+5*math.cos(angle))],fill="#53647c")
    for e in page["edges"]:
        pts=points(e,lookup); d.line(pts,fill="#53647c",width=2)
        arrow(pts[-1],pts[-2])
        if e["both"]: arrow(pts[0],pts[1])
    for n in page["nodes"]:
        fill,stroke=COLORS[n["kind"]]
        d.rounded_rectangle((n["x"],n["y"],n["x"]+n["w"],n["y"]+n["h"]),radius=12,fill=fill,outline=stroke,width=2)
        text(n["x"]+n["w"]/2,n["y"]+34,n["title"],21,True,True)
        for i,line in enumerate(lines(n)): text(n["x"]+n["w"]/2,n["y"]+66+i*24,line,17,False,True)
    for e in page["edges"]:
        if e["label"]:
            pts=points(e,lookup)
            x,y=e["label_at"] or ((pts[0][0]+pts[-1][0])/2,(pts[0][1]+pts[-1][1])/2-12)
            w=d.textlength(e["label"],font=font(17))+16
            d.rounded_rectangle((x-w/2,y-20,x+w/2,y+7),radius=5,fill="#f7f9fc")
            text(x,y,e["label"],17,False,True)
    text(55,1040,page["footer"],18)
    destination.parent.mkdir(parents=True,exist_ok=True)
    im.save(destination)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--png",type=Path,help="Optional PNG QA output directory (Windows fonts + Pillow).")
    args=parser.parse_args()
    (ROOT/"architecture.drawio").write_text(drawio(),encoding="utf-8")
    for page in PAGES:
        (ROOT/f'{page["id"]}.svg').write_text(svg(page),encoding="utf-8")
        if args.png: png(page,args.png/f'{page["id"]}.png')
    print(f"Generated {len(PAGES)} editable draw.io pages and {len(PAGES)} SVG previews.")


if __name__ == "__main__":
    main()
