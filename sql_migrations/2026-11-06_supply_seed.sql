-- Supply sources seed (2026-11-06): common consumables found on the public pages of our suppliers (no login), with pack size and price WITH VAT.
-- Each URL was fetched with the same reader the Edge Function uses (parse.mjs) and the price matched on 2026-11-06. Idempotent (on conflict do nothing).
-- Run AFTER 2026-11-06_supply_sources.sql.
insert into public.supply_catalog (id, name, icon, unit, base_unit, sort) values
  ('sc_coffee_caf','Kávové kapsule Tchibo Cafissimo','☕','balenie','kapsula',130),
  ('sc_coffee_nes','Kávové kapsule Nespresso','☕','balenie','kapsula',140),
  ('sc_coffee_dg','Kávové kapsule Dolce Gusto','☕','balenie','kapsula',150)
on conflict (id) do nothing;

update public.supply_catalog set base_unit = case id
  when 'sc_toilet' then 'kotúč'
  when 'sc_towels' then 'rolka'
  when 'sc_bath' then 'l'
  when 'sc_floor' then 'l'
  when 'sc_glass' then 'l'
  when 'sc_dish' then 'l'
  when 'sc_dishtab' then 'tableta'
  when 'sc_soap' then 'l'
  when 'sc_shower' then 'l'
  when 'sc_laundry' then 'pranie'
  when 'sc_bags' then 'vrecko'
  when 'sc_sponge' then 'ks'
  else base_unit end
where id in ('sc_toilet','sc_towels','sc_bath','sc_floor','sc_glass','sc_dish','sc_dishtab','sc_soap','sc_shower','sc_laundry','sc_bags','sc_sponge');

insert into public.supply_sources (id, catalog_id, supplier_id, shop, url, title, pack_qty, pack_note, price, price_checked_at, price_origin, auto_price, created_by) values
  ('ss_seed_001','sc_toilet','sup_1783329874687','HUMED','https://www.humed.sk/toaletny-papier-paloma-economy--2--vrst-100--celuloza--24--ks/','Toaletný papier PALOMA ECONOMY 2 vrst., 100% celulóza, 24 ks',24,'2-vrstvový',5.69,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_002','sc_toilet','sup_1783329874687','HUMED','https://www.humed.sk/toaletny-papier-grite-ecological-3vrst--8-ks/','Toaletný papier Grite Ecological 3vrst. 8 ks',8,'3-vrstvový',2.39,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_003','sc_toilet','sup_1783329874687','HUMED','https://www.humed.sk/toaletny-papier-cellart--family--3vrst--100--celuloza-16ks/','Toaletný papier CELLART FAMILY 3vrst. 100% celulóza 16ks',16,'3-vrstvový, 100 % celulóza',5.69,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_004','sc_towels','sup_1783329874687','HUMED','https://www.humed.sk/papierove-utierky-kuchynske-cellart--2-vrst-2ks/','Papierové utierky kuchynské CELLART, 2 vrst. - 2ks',2,'2-vrstvové',1.01,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_005','sc_towels','sup_1783329874687','HUMED','https://www.humed.sk/tork-extra-absorpcne-kuchynske-utierky-v--kotuci--biele-2ks/','Tork extra absorpčné kuchynské utierky v kotúči, biele - 2ks',2,'extra savé',2.9,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_006','sc_bath','sup_1783329874687','HUMED','https://www.humed.sk/satur-plus-na-kupelne--hrdzu-a-vodny-kamen-5l/','SATUR PLUS na kúpeľne, hrdzu a vodný kameň 5L',5,'kúpeľne, hrdza, vodný kameň',10.1,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_007','sc_bath','sup_1783329874687','HUMED','https://www.humed.sk/sanitiz-cistiaci-dezinfekcny-prostriedok-na-kupelne-1-5l/','SANITIZ čistiaci dezinfekčný prostriedok na kúpeľne 1,5l',1.5,'dezinfekčný',3.58,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_008','sc_bath','sup_1783329874687','HUMED','https://www.humed.sk/satur-plus-na-kupelne--hrdzu-a-vodny-kamen-500ml/','SATUR PLUS na kúpeľne, hrdzu a vodný kameň 500ml',0.5,'',1.75,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_009','sc_floor','sup_1783329874687','HUMED','https://www.humed.sk/go--mydlovy-cistic-na-nabytok-a-podlahy-1l/','GO! Mydlový čistič na nábytok a podlahy 1l',1,'mydlový, nábytok a podlahy',2.05,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_010','sc_floor','sup_1783329874687','HUMED','https://www.humed.sk/sidolux-expert-na-podlahy-drevene-a--laminatove-podlahy-pomaranc--750ml/','SIDOLUX EXPERT NA PODLAHY - drevené a laminátové podlahy - pomaranč 750ml',0.75,'drevené a laminátové podlahy',4.29,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_011','sc_glass','sup_1783329874687','HUMED','https://www.humed.sk/satur-okna-cistic-okien-5l/','SATUR OKNÁ čistič okien 5L',5,'',4.99,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_012','sc_glass','sup_1783329874687','HUMED','https://www.humed.sk/satur-okna-cistic-okien-500ml-s-rozprasovacom/','SATUR OKNÁ čistič okien 500ml s rozprašovačom',0.5,'s rozprašovačom',1.65,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_013','sc_glass','sup_1783329874687','HUMED','https://www.humed.sk/sidolux-na-okna-a-zrkadla-s-nano-technologiou-lemon-500ml/','SIDOLUX na okná a zrkadlá s NANO technológiou Lemon - 500ml',0.5,'',2.19,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_014','sc_dish','sup_1783329874687','HUMED','https://www.humed.sk/clee-na-riad-lemon-5l/','CLEE Na riad LEMON 5L',5,'kanister',4.9,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_015','sc_dish','sup_1783329874687','HUMED','https://www.humed.sk/fox-na-riad-a-upratovanie-5l/','FOX na riad a upratovanie 5l',5,'kanister',5.29,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_016','sc_dish','sup_1783329874687','HUMED','https://www.humed.sk/go--na-riad-aktivna-sila-1l/','GO! Na riad aktívna sila 1l',1,'',1.95,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_017','sc_dishtab','sup_1783329874687','HUMED','https://www.humed.sk/clee-tablety-do-umyvacky-riadu-all-in-one-300ks/','CLEE Tablety do umývačky riadu ALL in ONE - 300ks',300,'all in one',16.69,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_018','sc_dishtab','sup_1783329874687','HUMED','https://www.humed.sk/clee-tablety-do-umyvacky-riadu-all-in-one-200ks/','CLEE Tablety do umývačky riadu ALL in ONE - 200ks',200,'all in one',13.49,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_019','sc_dishtab','sup_1783329874687','HUMED','https://www.humed.sk/oxo-eco-tablety-do-umyvacky-riadu-120-ks/','OXO ECO tablety do umývačky riadu 120 ks',120,'eco',11.69,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_020','sc_dishtab','sup_1783329874687','HUMED','https://www.humed.sk/milit-activ-power-tablety-do-umyvacky-riadu-allin1-102ks/','Milit Activ Power tablety do umývačky riadu ALLin1 - 102ks',102,'all in 1',11.5,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_021','sc_soap','sup_1783329874687','HUMED','https://www.humed.sk/clee-tekute-mydlo-ocean-5l/','CLEE Tekuté mydlo OCEAN 5L',5,'kanister',4.59,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_022','sc_soap','sup_1783329874687','HUMED','https://www.humed.sk/vione-tekute-mydlo-neparfemovane-5l/','Vione tekuté mydlo neparfemované 5l',5,'neparfémované, kanister',4.99,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_023','sc_soap','sup_1783329874687','HUMED','https://www.humed.sk/vione-tekute-mydlo-s-bielou-perletou-1l/','VIONE TEKUTÉ MYDLO s bielou perleťou 1l',1,'s perleťou',1.65,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_024','sc_shower','sup_1783329874687','HUMED','https://www.humed.sk/vione-telovy-a-vlasovy-sampon-avokado-5l/','VIONE telový a vlasový šampón avokádo 5L',5,'telový a vlasový, kanister',5.95,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_025','sc_shower','sup_1783329874687','HUMED','https://www.humed.sk/vione-sampon-breza-1l/','VIONE ŠAMPÓN BREZA 1l',1,'šampón',1.65,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_026','sc_shower','sup_1783329874687','HUMED','https://www.humed.sk/dr--sante-aloe-vera-sampon-na-vlasy-s-vytazkami-aloe-vera-1l/','Dr. Santé Aloe Vera šampón na vlasy s výťažkami aloe vera 1l',1,'šampón Dr. Santé',7.2,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_027','sc_laundry','sup_1783329874687','HUMED','https://www.humed.sk/proff-gel-na-pranie-color-3l-60-pd/','PROFF gél na pranie Color 3L - 60 PD',60,'gél Color, 3 l',3.99,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_028','sc_laundry','sup_1783329874687','HUMED','https://www.humed.sk/milit-praci-gel-white-color-5-04l-112pd/','MILIT prací gél WHITE & COLOR 5,04L-112PD',112,'gél white & color, 5,04 l',8.95,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_029','sc_laundry','sup_1783329874687','HUMED','https://www.humed.sk/sidolux-multicaps-white---30ks/','SIDOLUX Multicaps White – pracie kapsule 30ks',30,'kapsule',9.59,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_030','sc_laundry','sup_1783329874687','HUMED','https://www.humed.sk/ariel-allin1-pods-pracie-kapsule-color-12ks/','Ariel Allin1 PODS pracie kapsule Color 12ks',12,'kapsule',5.59,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_031','sc_bags','sup_1783329874687','HUMED','https://www.humed.sk/hdpe---mikrotenove-vrecia-ulith-na-odpad-transparentne--60-litrov--50-ks/','HDPE – Mikroténové vrecia ULITH na odpad transparentné, 60 litrov, 50 ks',50,'60 l',1.99,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_032','sc_bags','sup_1783329874687','HUMED','https://www.humed.sk/hdpe---mikrotenove-vrecia-ulith-na-odpad-transparentne-30-litrov--50-ks/','HDPE – Mikroténové vrecia ULITH na odpad transparentné 30 litrov, 50 ks',50,'30 l',0.95,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_033','sc_sponge','sup_1783329874687','HUMED','https://www.humed.sk/hubka-na-riad-elitex-10-ks/','Hubka na riad ELITEX 10 ks',10,'',0.69,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_034','sc_sponge','sup_1783329874687','HUMED','https://www.humed.sk/hubka-na-riad-big-10ks/','Hubka na riad BIG 10ks',10,'BIG',0.89,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_035','sc_coffee_caf','sup_1779708893431','Tchibo','https://www.tchibo.sk/products/215421551905/cafissimo-caffe-crema-silna?article_id=165860880648','Cafissimo Caffè Crema silná - 80 kapsúl',80,'Caffè Crema silná',35.99,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_036','sc_coffee_caf','sup_1779708893431','Tchibo','https://www.tchibo.sk/products/203538102116/cafissimo-best-of-cafissimo-30-kapsul','Cafissimo Best of Cafissimo 30 kapsúl – 30 kapsúl',30,'Best of Cafissimo',13.49,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_037','sc_coffee_caf','sup_1779708893431','Tchibo','https://www.tchibo.sk/products/215421551905/cafissimo-caffe-crema-silna?article_id=163985144855','Cafissimo Caffè Crema silná - 10 kapsúl',10,'Caffè Crema silná',5.19,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_038','sc_coffee_nes','sup_1783328901771','Kaffek','https://kaffek.sk/big-pack-100-lungo-cafe-rene-nespresso.html','Café René | Lungo - 100 kapsúl do kávovaru Nespresso®',100,'Café René Lungo',12.19,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_039','sc_coffee_nes','sup_1783328901771','Kaffek','https://kaffek.sk/lungo-strong-kaffek-nespresso-50.html','KaffeK | Lungo Strong - 50 kapsúl do kávovaru Nespresso®',50,'KaffeK Lungo Strong',7.19,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_040','sc_coffee_dg','sup_1783328901771','Kaffek','https://kaffek.sk/americano-kaffek-dolce-gusto-32.html','KaffeK | Americano - 32 kapsúl do kávovaru Dolce Gusto',32,'KaffeK Americano',5.09,now(),'auto',true,'seed 2026-11-06'),
  ('ss_seed_041','sc_coffee_dg','sup_1783328901771','Kaffek','https://kaffek.sk/lungo-budget-kaffek-dolce-gusto-16.html','KaffeK | Lungo - Budget - 16 kapsúl do kávovaru Dolce Gusto®',16,'KaffeK Lungo Budget',2.35,now(),'auto',true,'seed 2026-11-06')
on conflict (id) do nothing;

insert into public.supply_price_log (source_id, price)
select s.id, s.price from public.supply_sources s
where s.created_by = 'seed 2026-11-06' and not exists (select 1 from public.supply_price_log l where l.source_id = s.id);
