"""
Turkish 81 Cities & Official Districts Mapping for Deep Regional Crawling (2025 Dataset).
Provides canonical location data and Turkish diacritics normalization.
"""
import re
from typing import List, Optional

# Turkish diacritics mapping for normalization (comparison only, display values preserved)
_TR_NORMALIZE_MAP = str.maketrans(
    "çğıöşüÇĞİÖŞÜ",
    "cgiosuCGIOSU"
)


def normalize_turkish(text: str) -> str:
    """
    Normalizes Turkish text for diacritics-insensitive comparison.
    Preserves original display value — use only for matching.
    Example: 'Ataşehir' -> 'atasehir'
    """
    if not text:
        return ""
    return text.translate(_TR_NORMALIZE_MAP).lower().strip()


TURKEY_LOCATIONS = [
    {
        "name": "İstanbul",
        "districts": [
            "Adalar", "Arnavutköy", "Ataşehir", "Avcılar", "Bağcılar", "Bahçelievler",
            "Bakırköy", "Başakşehir", "Bayrampaşa", "Beşiktaş", "Beykoz", "Beylikdüzü",
            "Beyoğlu", "Büyükçekmece", "Çatalca", "Çekmeköy", "Esenler", "Esenyurt",
            "Eyüpsultan", "Fatih", "Gaziosmanpaşa", "Güngören", "Kadıköy", "Kağıthane",
            "Kartal", "Küçükçekmece", "Maltepe", "Pendik", "Sancaktepe", "Sarıyer",
            "Silivri", "Sultanbeyli", "Sultangazi", "Şile", "Şişli", "Tuzla",
            "Ümraniye", "Üsküdar", "Zeytinburnu"
        ]
    },
    {
        "name": "Ankara",
        "districts": [
            "Akyurt", "Altındağ", "Ayaş", "Bala", "Beypazarı", "Çamlıdere",
            "Çankaya", "Çubuk", "Elmadağ", "Etimesgut", "Evren", "Gölbaşı",
            "Güdül", "Haymana", "Kahramankazan", "Kalecik", "Keçiören", "Kızılcahamam",
            "Mamak", "Nallıhan", "Polatlı", "Pursaklar", "Sincan", "Şereflikoçhisar",
            "Yenimahalle"
        ]
    },
    {
        "name": "İzmir",
        "districts": [
            "Aliağa", "Balçova", "Bayındır", "Bayraklı", "Bergama", "Beydağ",
            "Bornova", "Buca", "Çeşme", "Çiğli", "Dikili", "Foça",
            "Gaziemir", "Güzelbahçe", "Karabağlar", "Karaburun", "Karşıyaka", "Kemalpaşa",
            "Kınık", "Kiraz", "Konak", "Menderes", "Menemen", "Narlıdere",
            "Ödemiş", "Seferihisar", "Selçuk", "Tire", "Torbalı", "Urla"
        ]
    },
    {
        "name": "Bursa",
        "districts": [
            "Büyükorhan", "Gemlik", "Gürsu", "Harmancık", "İnegöl", "İznik",
            "Karacabey", "Keles", "Kestel", "Mudanya", "Mustafakemalpaşa", "Nilüfer",
            "Orhaneli", "Orhangazi", "Osmangazi", "Yenişehir", "Yıldırım"
        ]
    },
    {
        "name": "Antalya",
        "districts": [
            "Akseki", "Aksu", "Alanya", "Demre", "Döşemealtı", "Elmalı",
            "Finike", "Gazipaşa", "Gündoğmuş", "İbradı", "Kaş", "Kemer",
            "Kepez", "Konyaaltı", "Korkuteli", "Kumluca", "Manavgat", "Muratpaşa",
            "Serik"
        ]
    },
    {
        "name": "Adana",
        "districts": [
            "Aladağ", "Ceyhan", "Çukurova", "Feke", "İmamoğlu", "Karaisalı",
            "Karataş", "Kozan", "Pozantı", "Saimbeyli", "Sarıçam", "Seyhan",
            "Tufanbeyli", "Yumurtalık", "Yüreğir"
        ]
    },
    {
        "name": "Konya",
        "districts": [
            "Ahırlı", "Akören", "Akşehir", "Altınekin", "Beyşehir", "Bozkır",
            "Cihanbeyli", "Çeltik", "Çumra", "Derbent", "Derebucak", "Doğanhisar",
            "Emirgazi", "Ereğli", "Güneysınır", "Hadim", "Halkapınar", "Hüyük",
            "Ilgın", "Kadınhanı", "Karapınar", "Karatay", "Kulu", "Meram",
            "Sarayönü", "Selçuklu", "Seydişehir", "Taşkent", "Tuzlukçu", "Yalıhüyük",
            "Yunak"
        ]
    },
    {
        "name": "Gaziantep",
        "districts": [
            "Araban", "İslahiye", "Karkamış", "Nizip", "Nurdağı", "Oğuzeli",
            "Şahinbey", "Şehitkamil", "Yavuzeli"
        ]
    },
    {
        "name": "Kocaeli",
        "districts": [
            "Başiskele", "Çayırova", "Darıca", "Derince", "Dilovası", "Gebze",
            "Gölcük", "İzmit", "Kandıra", "Karamürsel", "Kartepe", "Körfez"
        ]
    },
    {
        "name": "Mersin",
        "districts": [
            "Akdeniz", "Anamur", "Aydıncık", "Bozyazı", "Çamlıyayla", "Erdemli",
            "Gülnar", "Mezitli", "Mut", "Silifke", "Tarsus", "Toroslar",
            "Yenişehir"
        ]
    },
    {
        "name": "Kayseri",
        "districts": [
            "Akkışla", "Bünyan", "Develi", "Felahiye", "Hacılar", "İncesu",
            "Kocasinan", "Melikgazi", "Özvatan", "Pınarbaşı", "Sarıoğlan", "Sarız",
            "Talas", "Tomarza", "Yahyalı", "Yeşilhisar"
        ]
    },
    {
        "name": "Eskişehir",
        "districts": [
            "Alpu", "Beylikova", "Çifteler", "Günyüzü", "Han", "İnönü",
            "Mahmudiye", "Mihalgazi", "Mihalıççık", "Odunpazarı", "Sarıcakaya", "Seyitgazi",
            "Sivrihisar", "Tepebaşı"
        ]
    },
    {
        "name": "Samsun",
        "districts": [
            "Alaçam", "Asarcık", "Atakum", "Ayvacık", "Bafra", "Canik",
            "Çarşamba", "Havza", "İlkadım", "Kavak", "Ladik", "Salıpazarı",
            "Tekkeköy", "Terme", "Vezirköprü", "Yakakent", "19 Mayıs"
        ]
    },
    {
        "name": "Denizli",
        "districts": [
            "Acıpayam", "Babadağ", "Baklan", "Bekilli", "Beyağaç", "Bozkurt",
            "Buldan", "Çal", "Çameli", "Çardak", "Çivril", "Güney",
            "Honaz", "Kale", "Merkezefendi", "Pamukkale", "Sarayköy", "Serinhisar",
            "Tavas"
        ]
    },
    {
        "name": "Sakarya",
        "districts": [
            "Adapazarı", "Akyazı", "Arifiye", "Erenler", "Ferizli", "Geyve",
            "Hendek", "Karapürçek", "Karasu", "Kaynarca", "Kocaali", "Pamukova",
            "Sapanca", "Serdivan", "Söğütlü", "Taraklı"
        ]
    },
    {
        "name": "Muğla",
        "districts": [
            "Bodrum", "Dalaman", "Datça", "Fethiye", "Kavaklıdere", "Köyceğiz",
            "Marmaris", "Menteşe", "Milas", "Ortaca", "Seydikemer", "Ula",
            "Yatağan"
        ]
    },
    {
        "name": "Tekirdağ",
        "districts": [
            "Çerkezköy", "Çorlu", "Ergene", "Hayrabolu", "Kapaklı", "Malkara",
            "Marmaraereğlisi", "Muratlı", "Saray", "Süleymanpaşa", "Şarköy"
        ]
    },
    {
        "name": "Balıkesir",
        "districts": [
            "Altıeylül", "Ayvalık", "Balya", "Bandırma", "Bigadiç", "Burhaniye",
            "Dursunbey", "Edremit", "Erdek", "Gömeç", "Gönen", "Havran",
            "İvrindi", "Karesi", "Kepsut", "Manyas", "Marmara", "Savaştepe",
            "Sındırgı", "Susurluk"
        ]
    },
    {
        "name": "Trabzon",
        "districts": [
            "Akçaabat", "Araklı", "Arsin", "Beşikdüzü", "Çarşıbaşı", "Çaykara",
            "Dernekpazarı", "Düzköy", "Hayrat", "Köprübaşı", "Maçka", "Of",
            "Ortahisar", "Sürmene", "Şalpazarı", "Tonya", "Vakfıkebir", "Yomra"
        ]
    },
    {
        "name": "Aydın",
        "districts": [
            "Bozdoğan", "Buharkent", "Çine", "Didim", "Efeler", "Germencik",
            "İncirliova", "Karacasu", "Karpuzlu", "Koçarlı", "Köşk", "Kuşadası",
            "Kuyucak", "Nazilli", "Söke", "Sultanhisar", "Yenipazar"
        ]
    },
    {
        "name": "Manisa",
        "districts": [
            "Ahmetli", "Akhisar", "Alaşehir", "Demirci", "Gölmarmara", "Gördes",
            "Kırkağaç", "Köprübaşı", "Kula", "Salihli", "Sarıgöl", "Saruhanlı",
            "Selendi", "Soma", "Şehzadeler", "Turgutlu", "Yunusemre"
        ]
    },
    {
        "name": "Diyarbakır",
        "districts": [
            "Bağlar", "Bismil", "Çermik", "Çınar", "Çüngüş", "Dicle",
            "Eğil", "Ergani", "Hani", "Hazro", "Kayapınar", "Kocaköy",
            "Kulp", "Lice", "Silvan", "Sur", "Yenişehir"
        ]
    },
    {
        "name": "Hatay",
        "districts": [
            "Altınözü", "Antakya", "Arsuz", "Belen", "Defne", "Dörtyol",
            "Erzin", "Hassa", "İskenderun", "Kırıkhan", "Kumlu", "Payas",
            "Reyhanlı", "Samandağ", "Yayladağı"
        ]
    },
    {
        "name": "Şanlıurfa",
        "districts": [
            "Akçakale", "Birecik", "Bozova", "Ceylanpınar", "Eyyübiye", "Halfeti",
            "Haliliye", "Harran", "Hilvan", "Karaköprü", "Siverek", "Suruç",
            "Viranşehir"
        ]
    },
    {
        "name": "Adıyaman",
        "districts": [
            "Besni", "Çelikhan", "Gerger", "Gölbaşı", "Kahta", "Merkez",
            "Samsat", "Sincik", "Tut"
        ]
    },
    {
        "name": "Afyonkarahisar",
        "districts": [
            "Başmakçı", "Bayat", "Bolvadin", "Çay", "Çobanlar", "Dazkırı",
            "Dinar", "Emirdağ", "Evciler", "Hocalar", "İhsaniye", "İscehisar",
            "Kızılören", "Merkez", "Sandıklı", "Sinanpaşa", "Sultandağı", "Şuhut"
        ]
    },
    {
        "name": "Ağrı",
        "districts": [
            "Diyadin", "Doğubayazıt", "Eleşkirt", "Hamur", "Merkez", "Patnos",
            "Taşlıçay", "Tutak"
        ]
    },
    {
        "name": "Aksaray",
        "districts": [
            "Ağaçören", "Eskil", "Gülağaç", "Güzelyurt", "Merkez", "Ortaköy",
            "Sarıyahşi", "Sultanhanı"
        ]
    },
    {
        "name": "Amasya",
        "districts": [
            "Göynücek", "Gümüşhacıköy", "Hamamözü", "Merkez", "Merzifon", "Suluova",
            "Taşova"
        ]
    },
    {
        "name": "Ardahan",
        "districts": [
            "Çıldır", "Damal", "Göle", "Hanak", "Merkez", "Posof"
        ]
    },
    {
        "name": "Artvin",
        "districts": [
            "Ardanuç", "Arhavi", "Borçka", "Hopa", "Kemalpaşa", "Merkez",
            "Murgul", "Şavşat", "Yusufeli"
        ]
    },
    {
        "name": "Bartın",
        "districts": [
            "Amasra", "Kurucaşile", "Merkez", "Ulus"
        ]
    },
    {
        "name": "Batman",
        "districts": [
            "Beşiri", "Gercüş", "Hasankeyf", "Kozluk", "Merkez", "Sason"
        ]
    },
    {
        "name": "Bayburt",
        "districts": [
            "Aydıntepe", "Demirözü", "Merkez"
        ]
    },
    {
        "name": "Bilecik",
        "districts": [
            "Bozüyük", "Gölpazarı", "İnhisar", "Merkez", "Osmaneli", "Pazaryeri",
            "Söğüt", "Yenipazar"
        ]
    },
    {
        "name": "Bingöl",
        "districts": [
            "Adaklı", "Genç", "Karlıova", "Kiğı", "Merkez", "Solhan",
            "Yayladere", "Yedisu"
        ]
    },
    {
        "name": "Bitlis",
        "districts": [
            "Adilcevaz", "Ahlat", "Güroymak", "Hizan", "Merkez", "Mutki",
            "Tatvan"
        ]
    },
    {
        "name": "Bolu",
        "districts": [
            "Dörtdivan", "Gerede", "Göynük", "Kıbrıscık", "Mengen", "Merkez",
            "Mudurnu", "Seben", "Yeniçağa"
        ]
    },
    {
        "name": "Burdur",
        "districts": [
            "Ağlasun", "Altınyayla", "Bucak", "Çavdır", "Çeltikçi", "Gölhisar",
            "Karamanlı", "Kemer", "Merkez", "Tefenni", "Yeşilova"
        ]
    },
    {
        "name": "Çanakkale",
        "districts": [
            "Ayvacık", "Bayramiç", "Biga", "Bozcaada", "Çan", "Eceabat",
            "Ezine", "Gelibolu", "Gökçeada", "Lapseki", "Merkez", "Yenice"
        ]
    },
    {
        "name": "Çankırı",
        "districts": [
            "Atkaracalar", "Bayramören", "Çerkeş", "Eldivan", "Ilgaz", "Kızılırmak",
            "Korgun", "Kurşunlu", "Merkez", "Orta", "Şabanözü", "Yapraklı"
        ]
    },
    {
        "name": "Çorum",
        "districts": [
            "Alaca", "Bayat", "Boğazkale", "Dodurga", "İskilip", "Kargı",
            "Laçin", "Mecitözü", "Merkez", "Oğuzlar", "Ortaköy", "Osmancık",
            "Sungurlu", "Uğurludağ"
        ]
    },
    {
        "name": "Düzce",
        "districts": [
            "Akçakoca", "Cumayeri", "Çilimli", "Gölyaka", "Gümüşova", "Kaynaşlı",
            "Merkez", "Yığılca"
        ]
    },
    {
        "name": "Edirne",
        "districts": [
            "Enez", "Havsa", "İpsala", "Keşan", "Lalapaşa", "Meriç",
            "Merkez", "Süloğlu", "Uzunköprü"
        ]
    },
    {
        "name": "Elazığ",
        "districts": [
            "Ağın", "Alacakaya", "Arıcak", "Baskil", "Karakoçan", "Keban",
            "Kovancılar", "Maden", "Merkez", "Palu", "Sivrice"
        ]
    },
    {
        "name": "Erzincan",
        "districts": [
            "Çayırlı", "İliç", "Kemah", "Kemaliye", "Merkez", "Otlukbeli",
            "Refahiye", "Tercan", "Üzümlü"
        ]
    },
    {
        "name": "Erzurum",
        "districts": [
            "Aşkale", "Aziziye", "Çat", "Hınıs", "Horasan", "İspir",
            "Karaçoban", "Karayazı", "Köprüköy", "Narman", "Oltu", "Olur",
            "Palandöken", "Pasinler", "Pazaryolu", "Şenkaya", "Tekman", "Tortum",
            "Uzundere", "Yakutiye"
        ]
    },
    {
        "name": "Giresun",
        "districts": [
            "Alucra", "Bulancak", "Çamoluk", "Çanakçı", "Dereli", "Doğankent",
            "Espiye", "Eynesil", "Görele", "Güce", "Keşap", "Merkez",
            "Piraziz", "Şebinkarahisar", "Tirebolu", "Yağlıdere"
        ]
    },
    {
        "name": "Gümüşhane",
        "districts": [
            "Kelkit", "Köse", "Kürtün", "Merkez", "Şiran", "Torul"
        ]
    },
    {
        "name": "Hakkari",
        "districts": [
            "Çukurca", "Derecik", "Merkez", "Şemdinli", "Yüksekova"
        ]
    },
    {
        "name": "Iğdır",
        "districts": [
            "Aralık", "Karakoyunlu", "Merkez", "Tuzluca"
        ]
    },
    {
        "name": "Isparta",
        "districts": [
            "Aksu", "Atabey", "Eğirdir", "Gelendost", "Gönen", "Keçiborlu",
            "Merkez", "Senirkent", "Sütçüler", "Şarkikaraağaç", "Uluborlu", "Yalvaç",
            "Yenişarbademli"
        ]
    },
    {
        "name": "Kahramanmaraş",
        "districts": [
            "Afşin", "Andırın", "Çağlayancerit", "Dulkadiroğlu", "Ekinözü", "Elbistan",
            "Göksun", "Nurhak", "Onikişubat", "Pazarcık", "Türkoğlu"
        ]
    },
    {
        "name": "Karabük",
        "districts": [
            "Eflani", "Eskipazar", "Merkez", "Ovacık", "Safranbolu", "Yenice"
        ]
    },
    {
        "name": "Karaman",
        "districts": [
            "Ayrancı", "Başyayla", "Ermenek", "Kazımkarabekir", "Merkez", "Sarıveliler"
        ]
    },
    {
        "name": "Kars",
        "districts": [
            "Akyaka", "Arpaçay", "Digor", "Kağızman", "Merkez", "Sarıkamış",
            "Selim", "Susuz"
        ]
    },
    {
        "name": "Kastamonu",
        "districts": [
            "Abana", "Ağlı", "Araç", "Azdavay", "Bozkurt", "Cide",
            "Çatalzeytin", "Daday", "Devrekani", "Doğanyurt", "Hanönü", "İhsangazi",
            "İnebolu", "Küre", "Merkez", "Pınarbaşı", "Seydiler", "Şenpazar",
            "Taşköprü", "Tosya"
        ]
    },
    {
        "name": "Kırıkkale",
        "districts": [
            "Bahşılı", "Balışeyh", "Çelebi", "Delice", "Karakeçili", "Keskin",
            "Merkez", "Sulakyurt", "Yahşihan"
        ]
    },
    {
        "name": "Kırklareli",
        "districts": [
            "Babaeski", "Demirköy", "Kofçaz", "Lüleburgaz", "Merkez", "Pehlivanköy",
            "Pınarhisar", "Vize"
        ]
    },
    {
        "name": "Kırşehir",
        "districts": [
            "Akçakent", "Akpınar", "Boztepe", "Çiçekdağı", "Kaman", "Merkez",
            "Mucur"
        ]
    },
    {
        "name": "Kilis",
        "districts": [
            "Elbeyli", "Merkez", "Musabeyli", "Polateli"
        ]
    },
    {
        "name": "Kütahya",
        "districts": [
            "Altıntaş", "Aslanapa", "Çavdarhisar", "Domaniç", "Dumlupınar", "Emet",
            "Gediz", "Hisarcık", "Merkez", "Pazarlar", "Simav", "Şaphane",
            "Tavşanlı"
        ]
    },
    {
        "name": "Malatya",
        "districts": [
            "Akçadağ", "Arapgir", "Arguvan", "Battalgazi", "Darende", "Doğanşehir",
            "Doğanyol", "Hekimhan", "Kale", "Kuluncak", "Pütürge", "Yazıhan",
            "Yeşilyurt"
        ]
    },
    {
        "name": "Mardin",
        "districts": [
            "Artuklu", "Dargeçit", "Derik", "Kızıltepe", "Mazıdağı", "Midyat",
            "Nusaybin", "Ömerli", "Savur", "Yeşilli"
        ]
    },
    {
        "name": "Muş",
        "districts": [
            "Bulanık", "Hasköy", "Korkut", "Malazgirt", "Merkez", "Varto"
        ]
    },
    {
        "name": "Nevşehir",
        "districts": [
            "Acıgöl", "Avanos", "Derinkuyu", "Gülşehir", "Hacıbektaş", "Kozaklı",
            "Merkez", "Ürgüp"
        ]
    },
    {
        "name": "Niğde",
        "districts": [
            "Altunhisar", "Bor", "Çamardı", "Çiftlik", "Merkez", "Ulukışla"
        ]
    },
    {
        "name": "Ordu",
        "districts": [
            "Akkuş", "Altınordu", "Aybastı", "Çamaş", "Çatalpınar", "Çaybaşı",
            "Fatsa", "Gölköy", "Gülyalı", "Gürgentepe", "İkizce", "Kabadüz",
            "Kabataş", "Korgan", "Kumru", "Mesudiye", "Perşembe", "Ulubey",
            "Ünye"
        ]
    },
    {
        "name": "Osmaniye",
        "districts": [
            "Bahçe", "Düziçi", "Hasanbeyli", "Kadirli", "Merkez", "Sumbas",
            "Toprakkale"
        ]
    },
    {
        "name": "Rize",
        "districts": [
            "Ardeşen", "Çamlıhemşin", "Çayeli", "Derepazarı", "Fındıklı", "Güneysu",
            "Hemşin", "İkizdere", "İyidere", "Kalkandere", "Merkez", "Pazar"
        ]
    },
    {
        "name": "Siirt",
        "districts": [
            "Baykan", "Eruh", "Kurtalan", "Merkez", "Pervari", "Şirvan",
            "Tillo"
        ]
    },
    {
        "name": "Sinop",
        "districts": [
            "Ayancık", "Boyabat", "Dikmen", "Durağan", "Erfelek", "Gerze",
            "Merkez", "Saraydüzü", "Türkeli"
        ]
    },
    {
        "name": "Sivas",
        "districts": [
            "Akıncılar", "Altınyayla", "Divriği", "Doğanşar", "Gemerek", "Gölova",
            "Gürün", "Hafik", "İmranlı", "Kangal", "Koyulhisar", "Merkez",
            "Suşehri", "Şarkışla", "Ulaş", "Yıldızeli", "Zara"
        ]
    },
    {
        "name": "Şırnak",
        "districts": [
            "Beytüşşebap", "Cizre", "Güçlükonak", "İdil", "Merkez", "Silopi",
            "Uludere"
        ]
    },
    {
        "name": "Tokat",
        "districts": [
            "Almus", "Artova", "Başçiftlik", "Erbaa", "Merkez", "Niksar",
            "Pazar", "Reşadiye", "Sulusaray", "Turhal", "Yeşilyurt", "Zile"
        ]
    },
    {
        "name": "Tunceli",
        "districts": [
            "Çemişgezek", "Hozat", "Mazgirt", "Merkez", "Nazımiye", "Ovacık",
            "Pertek", "Pülümür"
        ]
    },
    {
        "name": "Uşak",
        "districts": [
            "Banaz", "Eşme", "Karahallı", "Merkez", "Sivaslı", "Ulubey"
        ]
    },
    {
        "name": "Van",
        "districts": [
            "Bahçesaray", "Başkale", "Çaldıran", "Çatak", "Edremit", "Erciş",
            "Gevaş", "Gürpınar", "İpekyolu", "Muradiye", "Özalp", "Saray",
            "Tuşba"
        ]
    },
    {
        "name": "Yalova",
        "districts": [
            "Altınova", "Armutlu", "Çınarcık", "Çiftlikköy", "Merkez", "Termal"
        ]
    },
    {
        "name": "Yozgat",
        "districts": [
            "Akdağmadeni", "Aydıncık", "Boğazlıyan", "Çandır", "Çayıralan", "Çekerek",
            "Kadışehri", "Merkez", "Saraykent", "Sarıkaya", "Sorgun", "Şefaatli",
            "Yenifakılı", "Yerköy"
        ]
    },
    {
        "name": "Zonguldak",
        "districts": [
            "Alaplı", "Çaycuma", "Devrek", "Ereğli", "Gökçebey", "Kilimli",
            "Kozlu", "Merkez"
        ]
    },
]


def get_districts_for_city(city_name: str) -> List[str]:
    """Returns official districts for given city. Returns empty list if city not found."""
    norm_city = normalize_turkish(city_name)
    for c in TURKEY_LOCATIONS:
        if normalize_turkish(c["name"]) == norm_city:
            return list(c["districts"])
    return []


def get_supported_cities() -> List[str]:
    """Returns the canonical list of supported city names."""
    return [c["name"] for c in TURKEY_LOCATIONS]


def is_valid_district(city_name: str, district_name: str) -> bool:
    """Checks if a district belongs to the given city using normalized comparison."""
    districts = get_districts_for_city(city_name)
    norm_district = normalize_turkish(district_name)
    return any(normalize_turkish(d) == norm_district for d in districts)


def find_matching_district(city_name: str, text: str) -> Optional[str]:
    """
    Searches for any known district name within a text string (e.g., an address).
    Returns the canonical (display) district name if found, None otherwise.
    """
    if not text:
        return None
    norm_text = normalize_turkish(text)
    districts = get_districts_for_city(city_name)
    for d in districts:
        if normalize_turkish(d) in norm_text:
            return d
    return None
