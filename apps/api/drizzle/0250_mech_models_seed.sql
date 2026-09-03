-- Наполнение справочника моделей малой механизации присланным списком (план
-- `docs/mechanization-models-directory-plan.md`, §2 «Что в списке на самом деле» и §6 «Разбор
-- спорных строк»). Вторая из двух миграций этапа Э1; таблица заведена в 0249.
--
-- ИТОГ: прислано 104 строки, заведено 103. По этому числу сид и принимается.
--
-- ИСТОЧНИК похож на выгрузку из инвентаризации, а не на каталог: одна модель названа дважды, у
-- двух в наименовании стоит номер конкретной машины, у одной — «б/у». Заказчик подтвердил, что
-- это МОДЕЛИ («вполне очевидно, что это модели техники»), поэтому повтор схлопнут, а приметы
-- отдельных машин оставлены в наименованиях дословно — по ним заказчик эти позиции и узнаёт.
-- Разбор каждой спорной строки:
--
--   * ПОВТОР — «Правильно-гибочный станок SGW12D-3D» назван в списке два раза. Заведён одной
--     строкой: двух одинаковых моделей в справочнике не бывает, `mech_models_name_key_unique`
--     вторую и не пустит.
--   * СЕРИЙНЫЙ И ИНВЕНТАРНЫЙ НОМЕР — «Компрессор XAS970 Dd Euro Box сер.№06253380730709» и
--     «Бетононасос стационарный CIFA PC 907/612 (8316)». Перенесены дословно. В справочнике
--     МОДЕЛЕЙ номер конкретной машины лишний, но выбросить его молча нельзя: заказчик по нему
--     позицию и опознаёт. Скажет убрать — уберётся правкой строки в портале, а не миграцией.
--   * «(см)» — пять строк. Это пометка службы механизации (ответ заказчика 03.09.2026), не
--     размерность и не сокращение: разбирать её не просили, переносится как есть.
--   * «б/у» — одна строка, «Компрессор поршневой стационарный С416 б/у». Свойство конкретной
--     машины, а не модели, но снимается оно по той же причине, что и серийный номер: с ведома
--     заказчика, не молча.
--   * «(компл)» и «в комплекте с…» — пять строк. Это часть названия того, что выдают со склада
--     (станок с подставкой, мотоблок с утяжелителями), а не примечание к нему.
--   * ПРОБЕЛЫ — хвостовые у 90 строк из 104 и двойной внутри одной. Схлопнуты: они не значимы,
--     мешают поиску и в `name_key` всё равно свернулись бы, оставив в `name` мусор, видимый
--     человеку.
--
-- КОДЫ порождены транслитерацией наименования («Виброплита реверсивная Wacker DPU 3070Н» →
-- `vibroplita-reversivnaya-wacker-dpu-3070n`) и никому не показываются. Наименование целиком, а
-- не первые слова: модель различает как раз хвост («DPU 3060Н» против «DPU 3070Н»), и обрезка
-- кода по длине сделала бы коды соседних позиций неотличимыми. Код не меняется при правке
-- наименования — на этом держится обмен файлом (ADR 0073) и всё, что сошлётся на строку потом.
--
-- ПОРЯДОК — по алфавиту наименований, шаг 10. Шаг, а не 1, 2, 3: заведённую завтра модель ставят
-- между соседями числом посередине, не переписывая весь справочник. Алфавит здесь единственный
-- осмысленный порядок: групп («станки», «компрессоры», «насосы») заказчик не просил, а 103
-- позиции берут поиском по названию.
--
-- БЕЗ `ON CONFLICT`: таблица заведена файлом 0249 и до этой строки в неё физически некому было
-- писать — обе миграции едут одним выкатом, а старый код о таблице не знает. Молчаливое
-- `DO NOTHING` здесь скрыло бы единственную настоящую беду — повтор внутри самого списка, — а её
-- надо увидеть при накате.

INSERT INTO mech_models (code, name, sort_order) VALUES
  ('apparat-vysokogo-davleniya-bez-nagreva-vody-karcher-hd-9-20-4m',
   'Аппарат высокого давления без нагрева воды Karcher HD 9/20-4М', 10),
  ('betononasos-stacionarnyy-cifa-pc-907-612-8316',
   'Бетононасос стационарный CIFA PC 907/612 (8316)', 20),
  ('betononasos-stacionarnyy-putzmeister-bsa-1407d',
   'Бетононасос стационарный Putzmeister BSA 1407D', 30),
  ('betononasos-stacionarnyy-putzmeister-bsa-2109-h-d',
   'Бетононасос стационарный Putzmeister BSA 2109 H D', 40),
  ('vibroplita-reversivnaya-tss-wp265yh', 'Виброплита реверсивная TSS-WP265YH', 50),
  ('vibroplita-reversivnaya-wacker-dpu-3060n', 'Виброплита реверсивная Wacker DPU 3060Н', 60),
  ('vibroplita-reversivnaya-wacker-dpu-3070n', 'Виброплита реверсивная Wacker DPU 3070Н', 70),
  ('vibroplita-reversivnaya-wacker-dpu-3760n-sm',
   'Виброплита реверсивная Wacker DPU 3760Н (см)', 80),
  ('vibroplita-reversivnaya-wacker-dpu-5545he-sm',
   'Виброплита реверсивная Wacker DPU 5545He (см)', 90),
  ('vibroplita-reversivnaya-wacker-dpu-6555-heap',
   'Виброплита реверсивная Wacker DPU 6555 Heap', 100),
  ('vibroplita-reversivnaya-wacker-neuson-dpu-130',
   'Виброплита реверсивная Wacker Neuson DPU 130', 110),
  ('vibroplita-caiman-mikasa-mvc-f60h-vas', 'Виброплита Caiman Mikasa MVC-F60H VAS', 120),
  ('vibroplita-mikasa-mvb-85', 'Виброплита Mikasa MVB-85', 130),
  ('invertor-svarochnyy-torus-sw250-ar', 'Инвертор сварочный Торус SW250 AR', 140),
  ('instrument-mehanicheskiy-montazhnyy-pradex-d-16-32-kompl',
   'Инструмент механический монтажный Pradex D 16-32 (компл)', 150),
  ('instrument-ruchnoy-rasshiritelnyy-s-golovkami-uponor-16-20-25-kompl',
   'Инструмент ручной расширительный с головками Uponor 16-20-25 (компл)', 160),
  ('katok-odnovalcovyy-sdr-260-d', 'Каток одновальцовый SDR 260 D', 170),
  ('katok-transheynyy-wacker-neuson-rt-82-sc-2', 'Каток траншейный Wacker Neuson RT 82 SC 2', 180),
  ('kompressor-bezmaslyanyy-fubag-paint-master-kit',
   'Компрессор безмасляный Fubag Paint Master Kit', 190),
  ('kompressor-vintovoy-ingro-xlm-11a', 'Компрессор винтовой Ingro XLM 11A', 200),
  ('kompressor-vintovoy-ingro-xlm-30a-8-bar', 'Компрессор винтовой Ingro XLM 30A 8 бар', 210),
  ('kompressor-vintovoy-ingro-xlm-37a', 'Компрессор винтовой Ingro XLM 37A', 220),
  ('kompressor-vintovoy-ingro-xlm-45a', 'Компрессор винтовой Ingro XLM 45A', 230),
  ('kompressor-maslyanyy-zubr-kpm-320-24', 'Компрессор масляный ЗУБР КПМ-320-24', 240),
  ('kompressor-maslyanyy-fubag-ds-320-24-cm2-5', 'Компрессор масляный Fubag Dс 320/24 CM2.5', 250),
  ('kompressor-maslyanyy-fubag-dc-320-50-cm2-5', 'Компрессор масляный Fubag DC 320/50 CM2.5', 260),
  ('kompressor-porshnevoy-bezmaslyanyy-fubag-handy-master-kit',
   'Компрессор поршневой безмасляный Fubag Handy Master Kit', 270),
  ('kompressor-porshnevoy-peredvizhnoy-k-25m-avtomat',
   'Компрессор поршневой передвижной К-25М автомат', 280),
  ('kompressor-porshnevoy-stacionarnyy-s416-b-u',
   'Компрессор поршневой стационарный С416 б/у', 290),
  ('kompressor-porshnevoy-elitech-acf-500-50s', 'Компрессор поршневой Elitech ACF 500-50S', 300),
  ('kompressor-ganta-ac500-050-ofs-sm', 'Компрессор Ganta ac500/050 ofs (см)', 310),
  ('kompressor-xas970-dd-euro-box-ser-06253380730709',
   'Компрессор XAS970 Dd Euro Box сер.№06253380730709', 320),
  ('kompressornaya-vintovaya-elektricheskaya-stacionarnaya-stanciya-zif-sve-5-0-7-g-bez-kozhuha',
   'Компрессорная винтовая электрическая стационарная станция ЗИФ-СВЭ-5/0,7 G без кожуха', 330),
  ('kompressornaya-porshnevaya-peredvizhnaya-stanciya-pks-3-5a',
   'Компрессорная поршневая передвижная станция ПКС-3,5А', 340),
  ('mashina-zaglazhivayuschaya-odnorotornaya-robust-pro-900',
   'Машина заглаживающая однороторная Robust PRO 900', 350),
  ('mashina-zaglazhivayuschaya-po-betonu-bth36', 'Машина заглаживающая по бетону BTH36', 360),
  ('mashina-zaglazhivayuschaya-po-betonu-coopter-double-as-90',
   'Машина заглаживающая по бетону Coopter Double AS 90', 370),
  ('mashina-zaglazhivayuschaya-po-betonu-robust-sen-600',
   'Машина заглаживающая по бетону Robust SEN 600', 380),
  ('mashina-zaglazhivayuschaya-po-betonu-vektor-vscg-600e',
   'Машина заглаживающая по бетону Vektor VSCG-600E', 390),
  ('mashina-zaglazhivayuschaya-po-betonu-wacker-neuson-st24-220e',
   'Машина заглаживающая по бетону Wacker Neuson СТ24-220Е', 400),
  ('mashina-zaglazhivayuschaya-roadway-rwmg236a', 'Машина заглаживающая Roadway RWMG236A', 410),
  ('mashina-mozaichno-shlifovalnaya-htg-gx688', 'Машина мозаично-шлифовальная HTG GX688', 420),
  ('mashina-polomoechnaya-setevaya-karcher-bd-50-60c-c-ep-classic',
   'Машина поломоечная сетевая Karcher BD 50/60C C Ep Classic', 430),
  ('mehanizm-podayuschiy-kedr-alphawf-2-zakrytogo-tipa',
   'Механизм подающий КЕДР AlphaWF-2 (закрытого типа)', 440),
  ('motoblok-belarus-012wm', 'Мотоблок Беларус-012WM', 450),
  ('motoblok-belarus-09h-v-komplekte-s-utyazhelitelyami',
   'Мотоблок БЕЛАРУС-09H в комплекте с утяжелителями', 460),
  ('motoblok-kentavr-2091d-toyokawa', 'Мотоблок Кентавр 2091Д (Toyokawa)', 470),
  ('nasos-drenazhnyy-gnom-16h16d-s-poplavkom-stal',
   'Насос дренажный Гном 16х16Д с поплавком сталь', 480),
  ('nasos-drenazhnyy-speroni-stf-1000-hl', 'Насос дренажный Speroni STF 1000 HL', 490),
  ('nasos-drenazhnyy-tsurumi-hs-2-75s', 'Насос дренажный Tsurumi HS 2.75S', 500),
  ('nasos-drenazhnyy-zumfa-small-sr4-0-4-kvt', 'Насос дренажный Zumfa Small SR4 0,4 кВт', 510),
  ('nasos-opressovochnyy-elektricheskiy-rothenberger-rp-pro-iii',
   'Насос опрессовочный электрический Rothenberger RP PRO III', 520),
  ('nasos-pogruzhnoy-karcher-sp-7-dirt-inox', 'Насос погружной Karcher SP 7 Dirt Inox', 530),
  ('nasos-pogruzhnoy-pedrollo-top-2-vortex', 'Насос погружной Pedrollo TOP 2 Vortex', 540),
  ('nasos-porshnevoy-inekcionnyy-ip-600-2k-dlya-smol',
   'Насос поршневой инъекционный IP-600 2K для смол', 550),
  ('nasos-sadovyy-karcher-bp-4-garden-set', 'Насос садовый Karcher BP 4 Garden Set', 560),
  ('nasos-fekalnyy-pedrollo-bcm-10-50n', 'Насос фекальный Pedrollo BCm 10/50N', 570),
  ('poluavtomat-svarochnyy-svarog-tech-mig-250-380b-sm',
   'Полуавтомат сварочный Сварог Tech Mig 250 ,380B (см)', 580),
  ('pravilno-gibochnyy-stanok-sgw12d-3d', 'Правильно-гибочный станок SGW12D-3D', 590),
  ('pravilno-gibochnyy-stanok-sgw14d-1', 'Правильно-гибочный станок SGW14D-1', 600),
  ('pushka-teplovaya-gazovaya-general-ehp-46a', 'Пушка тепловая газовая General EHP 46A', 610),
  ('pushka-teplovaya-gazovaya-master-blp-17m', 'Пушка тепловая газовая Master BLP 17M', 620),
  ('pushka-teplovaya-gazovaya-master-blp-33m', 'Пушка тепловая газовая Master BLP 33M', 630),
  ('pushka-teplovaya-gazovaya-master-blp-53m', 'Пушка тепловая газовая Master BLP 53M', 640),
  ('pushka-teplovaya-gazovaya-master-blp-70', 'Пушка тепловая газовая Master BLP 70', 650),
  ('pushka-teplovaya-gazovaya-master-blp-73m', 'Пушка тепловая газовая Master BLP 73M', 660),
  ('pushka-teplovaya-dizelnaya-master-v-150-sed', 'Пушка тепловая дизельная Master В 150 СED', 670),
  ('pushka-teplovaya-dizelnaya-master-v-35-sed', 'Пушка тепловая дизельная Master В 35 СED', 680),
  ('pushka-teplovaya-dizelnaya-master-v-70-sed', 'Пушка тепловая дизельная Master В 70 СED', 690),
  ('pushka-teplovaya-ballu-bhp-m-3', 'Пушка тепловая Ballu BHP-M-3', 700),
  ('pylesos-promyshlennyy-htg-ivc-45l', 'Пылесос промышленный HTG IVC-45L', 710),
  ('pylesos-promyshlennyy-htg-ivc-f65l', 'Пылесос промышленный HTG IVC-F65L', 720),
  ('rastvoronasos-pnevmotransportnyy-strojstav-pneumix-px-500',
   'Растворонасос пневмотранспортный Strojstav Pneumix PX 500', 730),
  ('rezchik-shvov-splitstone-cs-1810e', 'Резчик швов Splitstone CS-1810E', 740),
  ('rezchik-shvov-splitstone-cs-3215e', 'Резчик швов Splitstone CS-3215E', 750),
  ('snegouborschik-mtd-optima-me-76', 'Снегоуборщик MTD Optima ME 76', 760),
  ('stanok-dlya-gibki-armatury-gms-b-45', 'Станок для гибки арматуры GMS B 45', 770),
  ('stanok-dlya-gibki-armatury-gms-b-50', 'Станок для гибки арматуры GMS B 50', 780),
  ('stanok-dlya-izgotovleniya-skob-i-homutov-ofmer-st16-rapida',
   'Станок для изготовления скоб и хомутов OFMER ST16 Rapida', 790),
  ('stanok-dlya-nakatki-zhelobkov-rems-magnum-2010-rg-t-s-oporoy-i-podstavkoy',
   'Станок для накатки желобков Rems Magnum 2010 RG-T с опорой и подставкой', 800),
  ('stanok-dlya-rezki-armatury-m-45', 'Станок для резки арматуры М 45', 810),
  ('stanok-dlya-rezki-armatury-r-55', 'Станок для резки арматуры Р-55', 820),
  ('stanok-dlya-rezki-armatury-s-52', 'Станок для резки арматуры С 52', 830),
  ('stanok-dlya-rezki-armatury-s-54', 'Станок для резки арматуры С 54', 840),
  ('stanok-dlya-rezki-armatury-s-55', 'Станок для резки арматуры С 55', 850),
  ('stanok-dlya-rezki-armatury-s-56', 'Станок для резки арматуры С 56', 860),
  ('stanok-dlya-rezki-armatury-smzh-175', 'Станок для резки арматуры СМЖ-175', 870),
  ('stanok-listogibochnyy-stalex-2500-1-0', 'Станок листогибочный Stalex 2500/1,0', 880),
  ('stanok-listogibochnyy-stalex-3000-1-0', 'Станок листогибочный Stalex 3000/1,0', 890),
  ('stanok-otreznoy-diam-pl-1200-1-6', 'Станок отрезной DIAM PL-1200/1.6', 900),
  ('stanok-otreznoy-diam-sk-800-2-2', 'Станок отрезной DIAM SK-800/2.2', 910),
  ('stanok-rezbonareznoy-rex-n100a-35a513-70b-1-4-4',
   'Станок резьбонарезной Rex N100A 35A513/70B 1/4"-4"', 920),
  ('stanok-rezbonareznoy-rex-np50a-1-2-2-v-komplekte-s-podstavkoy',
   'Станок резьбонарезной Rex NP50A 1/2"-2" в комплекте с подставкой', 930),
  ('stanok-rezbonareznoy-rex-np80-a1-4-3-v-komplekte-s-podstavkoy',
   'Станок резьбонарезной Rex NP80 A1/4"-3" в комплекте с подставкой', 940),
  ('stanok-sverlilnyy-hitachi-b16rm-735vt-lazer',
   'Станок сверлильный Hitachi B16RM 735Вт Лазер', 950),
  ('strela-betonoraspredelitelnaya-bvz12c-55m', 'Стрела бетонораспределительная BVZ12C-55M', 960),
  ('telezhka-gidravlicheskaya-noblelift-ac-25-115',
   'Тележка гидравлическая Noblelift AC-25-115', 970),
  ('telezhka-gidravlicheskaya-tor-rhp-2500kg', 'Тележка гидравлическая TOR RHP 2500кг', 980),
  ('teploventilyator-makar-tv-15k', 'Тепловентилятор Макар ТВ-15К', 990),
  ('teploventilyator-makar-tv-9', 'Тепловентилятор Макар ТВ-9', 1000),
  ('shlifmashina-po-betonu-htg-250vs-220b-sm', 'Шлифмашина по бетону HTG-250VS 220B (см)', 1010),
  ('shtukaturnaya-stanciya-m-tec-m-280', 'Штукатурная станция М-tec M-280', 1020),
  ('schetka-dlya-snegouborschika-mtd', 'Щетка для снегоуборщика MTD', 1030);
