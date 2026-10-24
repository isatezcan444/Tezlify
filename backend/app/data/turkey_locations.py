"""
Turkish 81 Cities & Official Districts Mapping for Deep Regional Crawling (2025 Dataset).
Provides canonical location data, district populations, and Turkish diacritics normalization.
"""
import re
from typing import List, Optional, Dict, Any

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

DISTRICT_METRICS: Dict[str, Dict[str, int]] = {
    "Adana:Aladağ": {
        "id": 1757,
        "population": 15839
    },
    "Adana:Ceyhan": {
        "id": 1219,
        "population": 156081
    },
    "Adana:Çukurova": {
        "id": 2033,
        "population": 380653
    },
    "Adana:Feke": {
        "id": 1329,
        "population": 15586
    },
    "Adana:İmamoğlu": {
        "id": 1806,
        "population": 27196
    },
    "Adana:Karaisalı": {
        "id": 1437,
        "population": 22872
    },
    "Adana:Karataş": {
        "id": 1443,
        "population": 24005
    },
    "Adana:Kozan": {
        "id": 1486,
        "population": 132572
    },
    "Adana:Pozantı": {
        "id": 1580,
        "population": 19983
    },
    "Adana:Saimbeyli": {
        "id": 1588,
        "population": 13133
    },
    "Adana:Sarıçam": {
        "id": 2032,
        "population": 263080
    },
    "Adana:Seyhan": {
        "id": 1104,
        "population": 782204
    },
    "Adana:Tufanbeyli": {
        "id": 1687,
        "population": 16027
    },
    "Adana:Yumurtalık": {
        "id": 1734,
        "population": 17806
    },
    "Adana:Yüreğir": {
        "id": 1748,
        "population": 396572
    },
    "Adıyaman:Besni": {
        "id": 1182,
        "population": 75398
    },
    "Adıyaman:Çelikhan": {
        "id": 1246,
        "population": 14530
    },
    "Adıyaman:Gerger": {
        "id": 1347,
        "population": 14497
    },
    "Adıyaman:Gölbaşı": {
        "id": 1354,
        "population": 47917
    },
    "Adıyaman:Kahta": {
        "id": 1425,
        "population": 136769
    },
    "Adıyaman:Merkez": {
        "id": 1105,
        "population": 296876
    },
    "Adıyaman:Samsat": {
        "id": 1592,
        "population": 6834
    },
    "Adıyaman:Sincik": {
        "id": 1985,
        "population": 15801
    },
    "Adıyaman:Tut": {
        "id": 1989,
        "population": 9199
    },
    "Afyonkarahisar:Başmakçı": {
        "id": 1771,
        "population": 9089
    },
    "Afyonkarahisar:Bayat": {
        "id": 1773,
        "population": 7580
    },
    "Afyonkarahisar:Bolvadin": {
        "id": 1200,
        "population": 45906
    },
    "Afyonkarahisar:Çay": {
        "id": 1239,
        "population": 29140
    },
    "Afyonkarahisar:Çobanlar": {
        "id": 1906,
        "population": 14457
    },
    "Afyonkarahisar:Dazkırı": {
        "id": 1267,
        "population": 11723
    },
    "Afyonkarahisar:Dinar": {
        "id": 1281,
        "population": 46878
    },
    "Afyonkarahisar:Emirdağ": {
        "id": 1306,
        "population": 43350
    },
    "Afyonkarahisar:Evciler": {
        "id": 1923,
        "population": 7038
    },
    "Afyonkarahisar:Hocalar": {
        "id": 1944,
        "population": 8220
    },
    "Afyonkarahisar:İhsaniye": {
        "id": 1404,
        "population": 27636
    },
    "Afyonkarahisar:İscehisar": {
        "id": 1809,
        "population": 25220
    },
    "Afyonkarahisar:Kızılören": {
        "id": 1961,
        "population": 1977
    },
    "Afyonkarahisar:Merkez": {
        "id": 1108,
        "population": 331982
    },
    "Afyonkarahisar:Sandıklı": {
        "id": 1594,
        "population": 54376
    },
    "Afyonkarahisar:Sinanpaşa": {
        "id": 1626,
        "population": 38292
    },
    "Afyonkarahisar:Şuhut": {
        "id": 1664,
        "population": 35303
    },
    "Afyonkarahisar:Sultandağı": {
        "id": 1639,
        "population": 13641
    },
    "Ağrı:Diyadin": {
        "id": 1283,
        "population": 35439
    },
    "Ağrı:Doğubayazıt": {
        "id": 1287,
        "population": 113699
    },
    "Ağrı:Eleşkirt": {
        "id": 1301,
        "population": 28661
    },
    "Ağrı:Hamur": {
        "id": 1379,
        "population": 14336
    },
    "Ağrı:Merkez": {
        "id": 1111,
        "population": 150035
    },
    "Ağrı:Patnos": {
        "id": 1568,
        "population": 105968
    },
    "Ağrı:Taşlıçay": {
        "id": 1667,
        "population": 17431
    },
    "Ağrı:Tutak": {
        "id": 1691,
        "population": 25920
    },
    "Aksaray:Ağaçören": {
        "id": 1860,
        "population": 7480
    },
    "Aksaray:Eskil": {
        "id": 1921,
        "population": 27946
    },
    "Aksaray:Gülağaç": {
        "id": 1932,
        "population": 19099
    },
    "Aksaray:Güzelyurt": {
        "id": 1861,
        "population": 10419
    },
    "Aksaray:Merkez": {
        "id": 1120,
        "population": 327575
    },
    "Aksaray:Ortaköy": {
        "id": 1557,
        "population": 31089
    },
    "Aksaray:Sarıyahşi": {
        "id": 1866,
        "population": 4717
    },
    "Aksaray:Sultanhanı": {
        "id": 2106,
        "population": 12811
    },
    "Amasya:Göynücek": {
        "id": 1363,
        "population": 10823
    },
    "Amasya:Gümüşhacıköy": {
        "id": 1368,
        "population": 22319
    },
    "Amasya:Hamamözü": {
        "id": 1938,
        "population": 3628
    },
    "Amasya:Merkez": {
        "id": 1134,
        "population": 151433
    },
    "Amasya:Merzifon": {
        "id": 1524,
        "population": 77077
    },
    "Amasya:Suluova": {
        "id": 1641,
        "population": 46928
    },
    "Amasya:Taşova": {
        "id": 1668,
        "population": 30034
    },
    "Ankara:Akyurt": {
        "id": 1872,
        "population": 46956
    },
    "Ankara:Altındağ": {
        "id": 1130,
        "population": 418072
    },
    "Ankara:Ayaş": {
        "id": 1157,
        "population": 13136
    },
    "Ankara:Bala": {
        "id": 1167,
        "population": 20109
    },
    "Ankara:Beypazarı": {
        "id": 1187,
        "population": 48359
    },
    "Ankara:Çamlıdere": {
        "id": 1227,
        "population": 10203
    },
    "Ankara:Çankaya": {
        "id": 1231,
        "population": 952198
    },
    "Ankara:Çubuk": {
        "id": 1260,
        "population": 101437
    },
    "Ankara:Elmadağ": {
        "id": 1302,
        "population": 45644
    },
    "Ankara:Etimesgut": {
        "id": 1922,
        "population": 632458
    },
    "Ankara:Evren": {
        "id": 1924,
        "population": 2927
    },
    "Ankara:Gölbaşı": {
        "id": 1744,
        "population": 172810
    },
    "Ankara:Güdül": {
        "id": 1365,
        "population": 8028
    },
    "Ankara:Haymana": {
        "id": 1387,
        "population": 25798
    },
    "Ankara:Kahramankazan": {
        "id": 1815,
        "population": 63143
    },
    "Ankara:Kalecik": {
        "id": 1427,
        "population": 12564
    },
    "Ankara:Keçiören": {
        "id": 1745,
        "population": 931722
    },
    "Ankara:Kızılcahamam": {
        "id": 1473,
        "population": 27841
    },
    "Ankara:Mamak": {
        "id": 1746,
        "population": 690329
    },
    "Ankara:Nallıhan": {
        "id": 1539,
        "population": 26083
    },
    "Ankara:Polatlı": {
        "id": 1578,
        "population": 131894
    },
    "Ankara:Pursaklar": {
        "id": 2034,
        "population": 168881
    },
    "Ankara:Şereflikoçhisar": {
        "id": 1658,
        "population": 32831
    },
    "Ankara:Sincan": {
        "id": 1747,
        "population": 605366
    },
    "Ankara:Yenimahalle": {
        "id": 1723,
        "population": 721531
    },
    "Antalya:Akseki": {
        "id": 1121,
        "population": 10609
    },
    "Antalya:Aksu": {
        "id": 2035,
        "population": 87070
    },
    "Antalya:Alanya": {
        "id": 1126,
        "population": 371547
    },
    "Antalya:Demre": {
        "id": 1811,
        "population": 28075
    },
    "Antalya:Döşemealtı": {
        "id": 2036,
        "population": 97121
    },
    "Antalya:Elmalı": {
        "id": 1303,
        "population": 41550
    },
    "Antalya:Finike": {
        "id": 1333,
        "population": 52436
    },
    "Antalya:Gazipaşa": {
        "id": 1337,
        "population": 55850
    },
    "Antalya:Gündoğmuş": {
        "id": 1370,
        "population": 6953
    },
    "Antalya:İbradı": {
        "id": 1946,
        "population": 3256
    },
    "Antalya:Kaş": {
        "id": 1451,
        "population": 63957
    },
    "Antalya:Kemer": {
        "id": 1959,
        "population": 52339
    },
    "Antalya:Kepez": {
        "id": 2037,
        "population": 649102
    },
    "Antalya:Konyaaltı": {
        "id": 2038,
        "population": 199414
    },
    "Antalya:Korkuteli": {
        "id": 1483,
        "population": 58381
    },
    "Antalya:Kumluca": {
        "id": 1492,
        "population": 75588
    },
    "Antalya:Manavgat": {
        "id": 1512,
        "population": 266480
    },
    "Antalya:Muratpaşa": {
        "id": 2039,
        "population": 510887
    },
    "Antalya:Serik": {
        "id": 1616,
        "population": 147062
    },
    "Ardahan:Çıldır": {
        "id": 1252,
        "population": 8048
    },
    "Ardahan:Damal": {
        "id": 2008,
        "population": 4526
    },
    "Ardahan:Göle": {
        "id": 1356,
        "population": 22038
    },
    "Ardahan:Hanak": {
        "id": 1380,
        "population": 7668
    },
    "Ardahan:Merkez": {
        "id": 1144,
        "population": 42136
    },
    "Ardahan:Posof": {
        "id": 1579,
        "population": 5976
    },
    "Artvin:Ardanuç": {
        "id": 1145,
        "population": 10889
    },
    "Artvin:Arhavi": {
        "id": 1147,
        "population": 22025
    },
    "Artvin:Borçka": {
        "id": 1202,
        "population": 21628
    },
    "Artvin:Hopa": {
        "id": 1395,
        "population": 27844
    },
    "Artvin:Kemalpaşa": {
        "id": 2105,
        "population": 9263
    },
    "Artvin:Merkez": {
        "id": 1152,
        "population": 35710
    },
    "Artvin:Murgul": {
        "id": 1828,
        "population": 6457
    },
    "Artvin:Şavşat": {
        "id": 1653,
        "population": 16151
    },
    "Artvin:Yusufeli": {
        "id": 1736,
        "population": 17564
    },
    "Aydın:Bozdoğan": {
        "id": 1206,
        "population": 31624
    },
    "Aydın:Buharkent": {
        "id": 1781,
        "population": 13137
    },
    "Aydın:Çine": {
        "id": 1256,
        "population": 47906
    },
    "Aydın:Didim": {
        "id": 2000,
        "population": 103141
    },
    "Aydın:Efeler": {
        "id": 2076,
        "population": 310241
    },
    "Aydın:Germencik": {
        "id": 1348,
        "population": 44697
    },
    "Aydın:İncirliova": {
        "id": 1807,
        "population": 58230
    },
    "Aydın:Karacasu": {
        "id": 1435,
        "population": 17225
    },
    "Aydın:Karpuzlu": {
        "id": 1957,
        "population": 10352
    },
    "Aydın:Koçarlı": {
        "id": 1479,
        "population": 22234
    },
    "Aydın:Köşk": {
        "id": 1968,
        "population": 28307
    },
    "Aydın:Kuşadası": {
        "id": 1497,
        "population": 141431
    },
    "Aydın:Kuyucak": {
        "id": 1498,
        "population": 26196
    },
    "Aydın:Nazilli": {
        "id": 1542,
        "population": 162156
    },
    "Aydın:Söke": {
        "id": 1637,
        "population": 123843
    },
    "Aydın:Sultanhisar": {
        "id": 1640,
        "population": 19791
    },
    "Aydın:Yenipazar": {
        "id": 1724,
        "population": 11596
    },
    "Balıkesir:Altıeylül": {
        "id": 2077,
        "population": 188858
    },
    "Balıkesir:Ayvalık": {
        "id": 1161,
        "population": 75815
    },
    "Balıkesir:Balya": {
        "id": 1169,
        "population": 12296
    },
    "Balıkesir:Bandırma": {
        "id": 1171,
        "population": 169476
    },
    "Balıkesir:Bigadiç": {
        "id": 1191,
        "population": 49275
    },
    "Balıkesir:Burhaniye": {
        "id": 1216,
        "population": 68370
    },
    "Balıkesir:Dursunbey": {
        "id": 1291,
        "population": 32168
    },
    "Balıkesir:Edremit": {
        "id": 1294,
        "population": 176251
    },
    "Balıkesir:Erdek": {
        "id": 1310,
        "population": 32080
    },
    "Balıkesir:Gömeç": {
        "id": 1928,
        "population": 19020
    },
    "Balıkesir:Gönen": {
        "id": 1360,
        "population": 75730
    },
    "Balıkesir:Havran": {
        "id": 1384,
        "population": 28152
    },
    "Balıkesir:İvrindi": {
        "id": 1418,
        "population": 31295
    },
    "Balıkesir:Karesi": {
        "id": 2078,
        "population": 189444
    },
    "Balıkesir:Kepsut": {
        "id": 1462,
        "population": 21386
    },
    "Balıkesir:Manyas": {
        "id": 1514,
        "population": 17650
    },
    "Balıkesir:Marmara": {
        "id": 1824,
        "population": 11827
    },
    "Balıkesir:Savaştepe": {
        "id": 1608,
        "population": 16266
    },
    "Balıkesir:Sındırgı": {
        "id": 1619,
        "population": 31482
    },
    "Balıkesir:Susurluk": {
        "id": 1644,
        "population": 37676
    },
    "Bartın:Amasra": {
        "id": 1761,
        "population": 13705
    },
    "Bartın:Kurucaşile": {
        "id": 1496,
        "population": 6316
    },
    "Bartın:Merkez": {
        "id": 1172,
        "population": 163766
    },
    "Bartın:Ulus": {
        "id": 1701,
        "population": 22876
    },
    "Batman:Beşiri": {
        "id": 1184,
        "population": 31864
    },
    "Batman:Gercüş": {
        "id": 1345,
        "population": 18894
    },
    "Batman:Hasankeyf": {
        "id": 1941,
        "population": 7152
    },
    "Batman:Kozluk": {
        "id": 1487,
        "population": 58781
    },
    "Batman:Merkez": {
        "id": 1174,
        "population": 517785
    },
    "Batman:Sason": {
        "id": 1607,
        "population": 28150
    },
    "Bayburt:Aydıntepe": {
        "id": 1767,
        "population": 5982
    },
    "Bayburt:Demirözü": {
        "id": 1788,
        "population": 8139
    },
    "Bayburt:Merkez": {
        "id": 1176,
        "population": 68715
    },
    "Bilecik:Bozüyük": {
        "id": 1210,
        "population": 81332
    },
    "Bilecik:Gölpazarı": {
        "id": 1359,
        "population": 10049
    },
    "Bilecik:İnhisar": {
        "id": 1948,
        "population": 2079
    },
    "Bilecik:Merkez": {
        "id": 1192,
        "population": 82863
    },
    "Bilecik:Osmaneli": {
        "id": 1559,
        "population": 22025
    },
    "Bilecik:Pazaryeri": {
        "id": 1571,
        "population": 9671
    },
    "Bilecik:Söğüt": {
        "id": 1636,
        "population": 18284
    },
    "Bilecik:Yenipazar": {
        "id": 1857,
        "population": 2692
    },
    "Bingöl:Adaklı": {
        "id": 1750,
        "population": 7491
    },
    "Bingöl:Genç": {
        "id": 1344,
        "population": 31654
    },
    "Bingöl:Karlıova": {
        "id": 1446,
        "population": 25265
    },
    "Bingöl:Kiğı": {
        "id": 1475,
        "population": 4487
    },
    "Bingöl:Merkez": {
        "id": 1193,
        "population": 175438
    },
    "Bingöl:Solhan": {
        "id": 1633,
        "population": 33233
    },
    "Bingöl:Yayladere": {
        "id": 1855,
        "population": 1889
    },
    "Bingöl:Yedisu": {
        "id": 1996,
        "population": 2842
    },
    "Bitlis:Adilcevaz": {
        "id": 1106,
        "population": 28769
    },
    "Bitlis:Ahlat": {
        "id": 1112,
        "population": 45637
    },
    "Bitlis:Güroymak": {
        "id": 1798,
        "population": 49372
    },
    "Bitlis:Hizan": {
        "id": 1394,
        "population": 29948
    },
    "Bitlis:Merkez": {
        "id": 1196,
        "population": 74904
    },
    "Bitlis:Mutki": {
        "id": 1537,
        "population": 26748
    },
    "Bitlis:Tatvan": {
        "id": 1669,
        "population": 105045
    },
    "Bolu:Dörtdivan": {
        "id": 1916,
        "population": 6214
    },
    "Bolu:Gerede": {
        "id": 1346,
        "population": 37196
    },
    "Bolu:Göynük": {
        "id": 1364,
        "population": 14257
    },
    "Bolu:Kıbrıscık": {
        "id": 1466,
        "population": 3783
    },
    "Bolu:Mengen": {
        "id": 1522,
        "population": 14152
    },
    "Bolu:Merkez": {
        "id": 1199,
        "population": 222589
    },
    "Bolu:Mudurnu": {
        "id": 1531,
        "population": 18101
    },
    "Bolu:Seben": {
        "id": 1610,
        "population": 4438
    },
    "Bolu:Yeniçağa": {
        "id": 1997,
        "population": 6443
    },
    "Burdur:Ağlasun": {
        "id": 1109,
        "population": 7347
    },
    "Burdur:Altınyayla": {
        "id": 1874,
        "population": 5060
    },
    "Burdur:Bucak": {
        "id": 1211,
        "population": 68312
    },
    "Burdur:Çavdır": {
        "id": 1899,
        "population": 12539
    },
    "Burdur:Çeltikçi": {
        "id": 1903,
        "population": 4914
    },
    "Burdur:Gölhisar": {
        "id": 1357,
        "population": 23969
    },
    "Burdur:Karamanlı": {
        "id": 1813,
        "population": 8097
    },
    "Burdur:Kemer": {
        "id": 1816,
        "population": 2727
    },
    "Burdur:Merkez": {
        "id": 1215,
        "population": 120832
    },
    "Burdur:Tefenni": {
        "id": 1672,
        "population": 9514
    },
    "Burdur:Yeşilova": {
        "id": 1728,
        "population": 13915
    },
    "Bursa:Büyükorhan": {
        "id": 1783,
        "population": 9148
    },
    "Bursa:Gemlik": {
        "id": 1343,
        "population": 124400
    },
    "Bursa:Gürsu": {
        "id": 1935,
        "population": 105799
    },
    "Bursa:Harmancık": {
        "id": 1799,
        "population": 6089
    },
    "Bursa:İnegöl": {
        "id": 1411,
        "population": 306004
    },
    "Bursa:İznik": {
        "id": 1420,
        "population": 45510
    },
    "Bursa:Karacabey": {
        "id": 1434,
        "population": 86543
    },
    "Bursa:Keles": {
        "id": 1457,
        "population": 10939
    },
    "Bursa:Kestel": {
        "id": 1960,
        "population": 77374
    },
    "Bursa:Mudanya": {
        "id": 1530,
        "population": 112225
    },
    "Bursa:Mustafakemalpaşa": {
        "id": 1535,
        "population": 103652
    },
    "Bursa:Nilüfer": {
        "id": 1829,
        "population": 578059
    },
    "Bursa:Orhaneli": {
        "id": 1553,
        "population": 18963
    },
    "Bursa:Orhangazi": {
        "id": 1554,
        "population": 81997
    },
    "Bursa:Osmangazi": {
        "id": 1832,
        "population": 886111
    },
    "Bursa:Yenişehir": {
        "id": 1725,
        "population": 55609
    },
    "Bursa:Yıldırım": {
        "id": 1859,
        "population": 654589
    },
    "Çanakkale:Ayvacık": {
        "id": 1160,
        "population": 35411
    },
    "Çanakkale:Bayramiç": {
        "id": 1180,
        "population": 28480
    },
    "Çanakkale:Biga": {
        "id": 1190,
        "population": 94526
    },
    "Çanakkale:Bozcaada": {
        "id": 1205,
        "population": 3384
    },
    "Çanakkale:Çan": {
        "id": 1229,
        "population": 46612
    },
    "Çanakkale:Eceabat": {
        "id": 1293,
        "population": 8746
    },
    "Çanakkale:Ezine": {
        "id": 1326,
        "population": 31894
    },
    "Çanakkale:Gelibolu": {
        "id": 1340,
        "population": 44689
    },
    "Çanakkale:Gökçeada": {
        "id": 1408,
        "population": 11331
    },
    "Çanakkale:Lapseki": {
        "id": 1503,
        "population": 30654
    },
    "Çanakkale:Merkez": {
        "id": 1230,
        "population": 208613
    },
    "Çanakkale:Yenice": {
        "id": 1722,
        "population": 29636
    },
    "Çankırı:Atkaracalar": {
        "id": 1765,
        "population": 5063
    },
    "Çankırı:Bayramören": {
        "id": 1885,
        "population": 2209
    },
    "Çankırı:Çerkeş": {
        "id": 1248,
        "population": 16927
    },
    "Çankırı:Eldivan": {
        "id": 1300,
        "population": 6198
    },
    "Çankırı:Ilgaz": {
        "id": 1399,
        "population": 13948
    },
    "Çankırı:Kızılırmak": {
        "id": 1817,
        "population": 6830
    },
    "Çankırı:Korgun": {
        "id": 1963,
        "population": 4239
    },
    "Çankırı:Kurşunlu": {
        "id": 1494,
        "population": 9130
    },
    "Çankırı:Merkez": {
        "id": 1232,
        "population": 99287
    },
    "Çankırı:Orta": {
        "id": 1555,
        "population": 17223
    },
    "Çankırı:Şabanözü": {
        "id": 1649,
        "population": 12493
    },
    "Çankırı:Yapraklı": {
        "id": 1718,
        "population": 7002
    },
    "Çorum:Alaca": {
        "id": 1124,
        "population": 28989
    },
    "Çorum:Bayat": {
        "id": 1177,
        "population": 13312
    },
    "Çorum:Boğazkale": {
        "id": 1778,
        "population": 3587
    },
    "Çorum:Dodurga": {
        "id": 1911,
        "population": 5036
    },
    "Çorum:İskilip": {
        "id": 1414,
        "population": 28132
    },
    "Çorum:Kargı": {
        "id": 1445,
        "population": 15119
    },
    "Çorum:Laçin": {
        "id": 1972,
        "population": 4094
    },
    "Çorum:Mecitözü": {
        "id": 1520,
        "population": 12911
    },
    "Çorum:Merkez": {
        "id": 1259,
        "population": 299565
    },
    "Çorum:Oğuzlar": {
        "id": 1976,
        "population": 4610
    },
    "Çorum:Ortaköy": {
        "id": 1556,
        "population": 6491
    },
    "Çorum:Osmancık": {
        "id": 1558,
        "population": 42673
    },
    "Çorum:Sungurlu": {
        "id": 1642,
        "population": 49079
    },
    "Çorum:Uğurludağ": {
        "id": 1850,
        "population": 5992
    },
    "Denizli:Acıpayam": {
        "id": 1102,
        "population": 54769
    },
    "Denizli:Babadağ": {
        "id": 1769,
        "population": 6199
    },
    "Denizli:Baklan": {
        "id": 1881,
        "population": 5266
    },
    "Denizli:Bekilli": {
        "id": 1774,
        "population": 6243
    },
    "Denizli:Beyağaç": {
        "id": 1888,
        "population": 6011
    },
    "Denizli:Bozkurt": {
        "id": 1889,
        "population": 11176
    },
    "Denizli:Buldan": {
        "id": 1214,
        "population": 26231
    },
    "Denizli:Çal": {
        "id": 1224,
        "population": 17277
    },
    "Denizli:Çameli": {
        "id": 1226,
        "population": 17447
    },
    "Denizli:Çardak": {
        "id": 1233,
        "population": 8497
    },
    "Denizli:Çivril": {
        "id": 1257,
        "population": 59689
    },
    "Denizli:Güney": {
        "id": 1371,
        "population": 9043
    },
    "Denizli:Honaz": {
        "id": 1803,
        "population": 34468
    },
    "Denizli:Kale": {
        "id": 1426,
        "population": 18855
    },
    "Denizli:Merkezefendi": {
        "id": 2079,
        "population": 351085
    },
    "Denizli:Pamukkale": {
        "id": 1871,
        "population": 343071
    },
    "Denizli:Sarayköy": {
        "id": 1597,
        "population": 30883
    },
    "Denizli:Serinhisar": {
        "id": 1840,
        "population": 14661
    },
    "Denizli:Tavas": {
        "id": 1670,
        "population": 40104
    },
    "Diyarbakır:Bağlar": {
        "id": 2040,
        "population": 402275
    },
    "Diyarbakır:Bismil": {
        "id": 1195,
        "population": 119815
    },
    "Diyarbakır:Çermik": {
        "id": 1249,
        "population": 49299
    },
    "Diyarbakır:Çınar": {
        "id": 1253,
        "population": 79114
    },
    "Diyarbakır:Çüngüş": {
        "id": 1263,
        "population": 10057
    },
    "Diyarbakır:Dicle": {
        "id": 1278,
        "population": 35948
    },
    "Diyarbakır:Eğil": {
        "id": 1791,
        "population": 21674
    },
    "Diyarbakır:Ergani": {
        "id": 1315,
        "population": 141098
    },
    "Diyarbakır:Hani": {
        "id": 1381,
        "population": 32285
    },
    "Diyarbakır:Hazro": {
        "id": 1389,
        "population": 16024
    },
    "Diyarbakır:Kayapınar": {
        "id": 2041,
        "population": 454311
    },
    "Diyarbakır:Kocaköy": {
        "id": 1962,
        "population": 15088
    },
    "Diyarbakır:Kulp": {
        "id": 1490,
        "population": 33973
    },
    "Diyarbakır:Lice": {
        "id": 1504,
        "population": 24060
    },
    "Diyarbakır:Silvan": {
        "id": 1624,
        "population": 86752
    },
    "Diyarbakır:Sur": {
        "id": 2042,
        "population": 97961
    },
    "Diyarbakır:Yenişehir": {
        "id": 2043,
        "population": 232622
    },
    "Düzce:Akçakoca": {
        "id": 1116,
        "population": 41134
    },
    "Düzce:Çilimli": {
        "id": 1905,
        "population": 19022
    },
    "Düzce:Cumayeri": {
        "id": 1784,
        "population": 16162
    },
    "Düzce:Gölyaka": {
        "id": 1794,
        "population": 20840
    },
    "Düzce:Gümüşova": {
        "id": 2017,
        "population": 17344
    },
    "Düzce:Kaynaşlı": {
        "id": 2031,
        "population": 20379
    },
    "Düzce:Merkez": {
        "id": 1292,
        "population": 267249
    },
    "Düzce:Yığılca": {
        "id": 1730,
        "population": 13492
    },
    "Edirne:Enez": {
        "id": 1307,
        "population": 10399
    },
    "Edirne:Havsa": {
        "id": 1385,
        "population": 17302
    },
    "Edirne:İpsala": {
        "id": 1412,
        "population": 25278
    },
    "Edirne:Keşan": {
        "id": 1464,
        "population": 85259
    },
    "Edirne:Lalapaşa": {
        "id": 1502,
        "population": 5932
    },
    "Edirne:Meriç": {
        "id": 1523,
        "population": 12329
    },
    "Edirne:Merkez": {
        "id": 1295,
        "population": 200753
    },
    "Edirne:Süloğlu": {
        "id": 1988,
        "population": 6101
    },
    "Edirne:Uzunköprü": {
        "id": 1705,
        "population": 59085
    },
    "Elazığ:Ağın": {
        "id": 1110,
        "population": 2532
    },
    "Elazığ:Alacakaya": {
        "id": 1873,
        "population": 5336
    },
    "Elazığ:Arıcak": {
        "id": 1762,
        "population": 12340
    },
    "Elazığ:Baskil": {
        "id": 1173,
        "population": 13397
    },
    "Elazığ:Karakoçan": {
        "id": 1438,
        "population": 28320
    },
    "Elazığ:Keban": {
        "id": 1455,
        "population": 7112
    },
    "Elazığ:Kovancılar": {
        "id": 1820,
        "population": 37874
    },
    "Elazığ:Maden": {
        "id": 1506,
        "population": 9139
    },
    "Elazığ:Merkez": {
        "id": 1298,
        "population": 463686
    },
    "Elazığ:Palu": {
        "id": 1566,
        "population": 17872
    },
    "Elazığ:Sivrice": {
        "id": 1631,
        "population": 8070
    },
    "Erzincan:Çayırlı": {
        "id": 1243,
        "population": 7491
    },
    "Erzincan:İliç": {
        "id": 1406,
        "population": 8543
    },
    "Erzincan:Kemah": {
        "id": 1459,
        "population": 6419
    },
    "Erzincan:Kemaliye": {
        "id": 1460,
        "population": 4484
    },
    "Erzincan:Merkez": {
        "id": 1318,
        "population": 169506
    },
    "Erzincan:Otlukbeli": {
        "id": 1977,
        "population": 2123
    },
    "Erzincan:Refahiye": {
        "id": 1583,
        "population": 10954
    },
    "Erzincan:Tercan": {
        "id": 1675,
        "population": 16145
    },
    "Erzincan:Üzümlü": {
        "id": 1853,
        "population": 13960
    },
    "Erzurum:Aşkale": {
        "id": 1153,
        "population": 19983
    },
    "Erzurum:Aziziye": {
        "id": 1945,
        "population": 71827
    },
    "Erzurum:Çat": {
        "id": 1235,
        "population": 14015
    },
    "Erzurum:Hınıs": {
        "id": 1392,
        "population": 23011
    },
    "Erzurum:Horasan": {
        "id": 1396,
        "population": 34896
    },
    "Erzurum:İspir": {
        "id": 1416,
        "population": 13984
    },
    "Erzurum:Karaçoban": {
        "id": 1812,
        "population": 19922
    },
    "Erzurum:Karayazı": {
        "id": 1444,
        "population": 22570
    },
    "Erzurum:Köprüköy": {
        "id": 1967,
        "population": 12903
    },
    "Erzurum:Narman": {
        "id": 1540,
        "population": 11119
    },
    "Erzurum:Oltu": {
        "id": 1550,
        "population": 29765
    },
    "Erzurum:Olur": {
        "id": 1551,
        "population": 5985
    },
    "Erzurum:Palandöken": {
        "id": 2044,
        "population": 181922
    },
    "Erzurum:Pasinler": {
        "id": 1567,
        "population": 25401
    },
    "Erzurum:Pazaryolu": {
        "id": 1865,
        "population": 3537
    },
    "Erzurum:Şenkaya": {
        "id": 1657,
        "population": 14918
    },
    "Erzurum:Tekman": {
        "id": 1674,
        "population": 20826
    },
    "Erzurum:Tortum": {
        "id": 1683,
        "population": 12881
    },
    "Erzurum:Uzundere": {
        "id": 1851,
        "population": 8263
    },
    "Erzurum:Yakutiye": {
        "id": 2045,
        "population": 189149
    },
    "Eskişehir:Alpu": {
        "id": 1759,
        "population": 9725
    },
    "Eskişehir:Beylikova": {
        "id": 1777,
        "population": 5611
    },
    "Eskişehir:Çifteler": {
        "id": 1255,
        "population": 14487
    },
    "Eskişehir:Günyüzü": {
        "id": 1934,
        "population": 5008
    },
    "Eskişehir:Han": {
        "id": 1939,
        "population": 2126
    },
    "Eskişehir:İnönü": {
        "id": 1808,
        "population": 6114
    },
    "Eskişehir:Mahmudiye": {
        "id": 1508,
        "population": 7407
    },
    "Eskişehir:Mihalgazi": {
        "id": 1973,
        "population": 2861
    },
    "Eskişehir:Mihalıççık": {
        "id": 1527,
        "population": 7605
    },
    "Eskişehir:Odunpazarı": {
        "id": 2046,
        "population": 431652
    },
    "Eskişehir:Sarıcakaya": {
        "id": 1599,
        "population": 4477
    },
    "Eskişehir:Seyitgazi": {
        "id": 1618,
        "population": 12565
    },
    "Eskişehir:Sivrihisar": {
        "id": 1632,
        "population": 20189
    },
    "Eskişehir:Tepebaşı": {
        "id": 2047,
        "population": 398129
    },
    "Gaziantep:Araban": {
        "id": 1139,
        "population": 32540
    },
    "Gaziantep:İslahiye": {
        "id": 1415,
        "population": 66107
    },
    "Gaziantep:Karkamış": {
        "id": 1956,
        "population": 9087
    },
    "Gaziantep:Nizip": {
        "id": 1546,
        "population": 152660
    },
    "Gaziantep:Nurdağı": {
        "id": 1974,
        "population": 38269
    },
    "Gaziantep:Oğuzeli": {
        "id": 1549,
        "population": 36644
    },
    "Gaziantep:Şahinbey": {
        "id": 1841,
        "population": 957792
    },
    "Gaziantep:Şehitkamil": {
        "id": 1844,
        "population": 905880
    },
    "Gaziantep:Yavuzeli": {
        "id": 1720,
        "population": 23436
    },
    "Giresun:Alucra": {
        "id": 1133,
        "population": 8473
    },
    "Giresun:Bulancak": {
        "id": 1212,
        "population": 70397
    },
    "Giresun:Çamoluk": {
        "id": 1893,
        "population": 5709
    },
    "Giresun:Çanakçı": {
        "id": 1894,
        "population": 5783
    },
    "Giresun:Dereli": {
        "id": 1272,
        "population": 20100
    },
    "Giresun:Doğankent": {
        "id": 1912,
        "population": 7327
    },
    "Giresun:Espiye": {
        "id": 1320,
        "population": 39182
    },
    "Giresun:Eynesil": {
        "id": 1324,
        "population": 12548
    },
    "Giresun:Görele": {
        "id": 1361,
        "population": 31536
    },
    "Giresun:Güce": {
        "id": 1930,
        "population": 8194
    },
    "Giresun:Keşap": {
        "id": 1465,
        "population": 20859
    },
    "Giresun:Merkez": {
        "id": 1352,
        "population": 143915
    },
    "Giresun:Piraziz": {
        "id": 1837,
        "population": 15109
    },
    "Giresun:Şebinkarahisar": {
        "id": 1654,
        "population": 19130
    },
    "Giresun:Tirebolu": {
        "id": 1678,
        "population": 32124
    },
    "Giresun:Yağlıdere": {
        "id": 1854,
        "population": 14688
    },
    "Gümüşhane:Kelkit": {
        "id": 1458,
        "population": 38520
    },
    "Gümüşhane:Köse": {
        "id": 1822,
        "population": 6107
    },
    "Gümüşhane:Kürtün": {
        "id": 1971,
        "population": 11327
    },
    "Gümüşhane:Merkez": {
        "id": 1369,
        "population": 54697
    },
    "Gümüşhane:Şiran": {
        "id": 1660,
        "population": 18377
    },
    "Gümüşhane:Torul": {
        "id": 1684,
        "population": 9779
    },
    "Hakkari:Çukurca": {
        "id": 1261,
        "population": 14299
    },
    "Hakkari:Derecik": {
        "id": 2107,
        "population": 24869
    },
    "Hakkari:Merkez": {
        "id": 1377,
        "population": 76165
    },
    "Hakkari:Şemdinli": {
        "id": 1656,
        "population": 43034
    },
    "Hakkari:Yüksekova": {
        "id": 1737,
        "population": 121314
    },
    "Hatay:Altınözü": {
        "id": 1131,
        "population": 69834
    },
    "Hatay:Antakya": {
        "id": 2080,
        "population": 301855
    },
    "Hatay:Arsuz": {
        "id": 2081,
        "population": 115077
    },
    "Hatay:Belen": {
        "id": 1887,
        "population": 37876
    },
    "Hatay:Defne": {
        "id": 2082,
        "population": 139605
    },
    "Hatay:Dörtyol": {
        "id": 1289,
        "population": 132987
    },
    "Hatay:Erzin": {
        "id": 1792,
        "population": 43103
    },
    "Hatay:Hassa": {
        "id": 1382,
        "population": 57457
    },
    "Hatay:İskenderun": {
        "id": 1413,
        "population": 228149
    },
    "Hatay:Kırıkhan": {
        "id": 1468,
        "population": 108200
    },
    "Hatay:Kumlu": {
        "id": 1970,
        "population": 16242
    },
    "Hatay:Payas": {
        "id": 2083,
        "population": 44530
    },
    "Hatay:Reyhanlı": {
        "id": 1585,
        "population": 117645
    },
    "Hatay:Samandağ": {
        "id": 1591,
        "population": 122952
    },
    "Hatay:Yayladağı": {
        "id": 1721,
        "population": 42019
    },
    "Iğdır:Aralık": {
        "id": 1142,
        "population": 18477
    },
    "Iğdır:Karakoyunlu": {
        "id": 2011,
        "population": 12614
    },
    "Iğdır:Merkez": {
        "id": 1398,
        "population": 152455
    },
    "Iğdır:Tuzluca": {
        "id": 1692,
        "population": 21525
    },
    "Isparta:Aksu": {
        "id": 1755,
        "population": 4073
    },
    "Isparta:Atabey": {
        "id": 1154,
        "population": 6204
    },
    "Isparta:Eğirdir": {
        "id": 1297,
        "population": 29200
    },
    "Isparta:Gelendost": {
        "id": 1341,
        "population": 13985
    },
    "Isparta:Gönen": {
        "id": 1929,
        "population": 7065
    },
    "Isparta:Keçiborlu": {
        "id": 1456,
        "population": 14033
    },
    "Isparta:Merkez": {
        "id": 1401,
        "population": 273638
    },
    "Isparta:Şarkikaraağaç": {
        "id": 1651,
        "population": 24310
    },
    "Isparta:Senirkent": {
        "id": 1615,
        "population": 10331
    },
    "Isparta:Sütçüler": {
        "id": 1648,
        "population": 9228
    },
    "Isparta:Uluborlu": {
        "id": 1699,
        "population": 6287
    },
    "Isparta:Yalvaç": {
        "id": 1717,
        "population": 44596
    },
    "Isparta:Yenişarbademli": {
        "id": 2001,
        "population": 2353
    },
    "İstanbul:Adalar": {
        "id": 1103,
        "population": 17489
    },
    "İstanbul:Arnavutköy": {
        "id": 2048,
        "population": 358469
    },
    "İstanbul:Ataşehir": {
        "id": 2049,
        "population": 412125
    },
    "İstanbul:Avcılar": {
        "id": 2003,
        "population": 440663
    },
    "İstanbul:Bağcılar": {
        "id": 2004,
        "population": 707635
    },
    "İstanbul:Bahçelievler": {
        "id": 2005,
        "population": 539035
    },
    "İstanbul:Bakırköy": {
        "id": 1166,
        "population": 218204
    },
    "İstanbul:Başakşehir": {
        "id": 2050,
        "population": 536797
    },
    "İstanbul:Bayrampaşa": {
        "id": 1886,
        "population": 272978
    },
    "İstanbul:Beşiktaş": {
        "id": 1183,
        "population": 165895
    },
    "İstanbul:Beykoz": {
        "id": 1185,
        "population": 246833
    },
    "İstanbul:Beylikdüzü": {
        "id": 2051,
        "population": 422988
    },
    "İstanbul:Beyoğlu": {
        "id": 1186,
        "population": 215991
    },
    "İstanbul:Büyükçekmece": {
        "id": 1782,
        "population": 283239
    },
    "İstanbul:Çatalca": {
        "id": 1237,
        "population": 81143
    },
    "İstanbul:Çekmeköy": {
        "id": 2052,
        "population": 315959
    },
    "İstanbul:Esenler": {
        "id": 2016,
        "population": 419878
    },
    "İstanbul:Esenyurt": {
        "id": 2053,
        "population": 1003905
    },
    "İstanbul:Eyüpsultan": {
        "id": 1325,
        "population": 425216
    },
    "İstanbul:Fatih": {
        "id": 1327,
        "population": 351786
    },
    "İstanbul:Gaziosmanpaşa": {
        "id": 1336,
        "population": 478395
    },
    "İstanbul:Güngören": {
        "id": 2010,
        "population": 251242
    },
    "İstanbul:Kadıköy": {
        "id": 1421,
        "population": 458573
    },
    "İstanbul:Kağıthane": {
        "id": 1810,
        "population": 446420
    },
    "İstanbul:Kartal": {
        "id": 1449,
        "population": 475630
    },
    "İstanbul:Küçükçekmece": {
        "id": 1823,
        "population": 785270
    },
    "İstanbul:Maltepe": {
        "id": 2012,
        "population": 525044
    },
    "İstanbul:Pendik": {
        "id": 1835,
        "population": 752033
    },
    "İstanbul:Sancaktepe": {
        "id": 2054,
        "population": 507500
    },
    "İstanbul:Sarıyer": {
        "id": 1604,
        "population": 344883
    },
    "İstanbul:Şile": {
        "id": 1659,
        "population": 50090
    },
    "İstanbul:Silivri": {
        "id": 1622,
        "population": 240029
    },
    "İstanbul:Şişli": {
        "id": 1663,
        "population": 261959
    },
    "İstanbul:Sultanbeyli": {
        "id": 2014,
        "population": 378908
    },
    "İstanbul:Sultangazi": {
        "id": 2055,
        "population": 529306
    },
    "İstanbul:Tuzla": {
        "id": 2015,
        "population": 313865
    },
    "İstanbul:Ümraniye": {
        "id": 1852,
        "population": 728913
    },
    "İstanbul:Üsküdar": {
        "id": 1708,
        "population": 514294
    },
    "İstanbul:Zeytinburnu": {
        "id": 1739,
        "population": 275471
    },
    "İzmir:Aliağa": {
        "id": 1128,
        "population": 110892
    },
    "İzmir:Balçova": {
        "id": 2006,
        "population": 75743
    },
    "İzmir:Bayındır": {
        "id": 1178,
        "population": 39971
    },
    "İzmir:Bayraklı": {
        "id": 2056,
        "population": 296481
    },
    "İzmir:Bergama": {
        "id": 1181,
        "population": 107549
    },
    "İzmir:Beydağ": {
        "id": 1776,
        "population": 11904
    },
    "İzmir:Bornova": {
        "id": 1203,
        "population": 452479
    },
    "İzmir:Buca": {
        "id": 1780,
        "population": 520941
    },
    "İzmir:Çeşme": {
        "id": 1251,
        "population": 51902
    },
    "İzmir:Çiğli": {
        "id": 2007,
        "population": 216430
    },
    "İzmir:Dikili": {
        "id": 1280,
        "population": 49138
    },
    "İzmir:Foça": {
        "id": 1334,
        "population": 37711
    },
    "İzmir:Gaziemir": {
        "id": 2009,
        "population": 137220
    },
    "İzmir:Güzelbahçe": {
        "id": 2018,
        "population": 39474
    },
    "İzmir:Karabağlar": {
        "id": 2057,
        "population": 467572
    },
    "İzmir:Karaburun": {
        "id": 1432,
        "population": 13725
    },
    "İzmir:Karşıyaka": {
        "id": 1448,
        "population": 339624
    },
    "İzmir:Kemalpaşa": {
        "id": 1461,
        "population": 122840
    },
    "İzmir:Kınık": {
        "id": 1467,
        "population": 28604
    },
    "İzmir:Kiraz": {
        "id": 1477,
        "population": 43340
    },
    "İzmir:Konak": {
        "id": 1819,
        "population": 317399
    },
    "İzmir:Menderes": {
        "id": 1826,
        "population": 112853
    },
    "İzmir:Menemen": {
        "id": 1521,
        "population": 220510
    },
    "İzmir:Narlıdere": {
        "id": 2013,
        "population": 61320
    },
    "İzmir:Ödemiş": {
        "id": 1563,
        "population": 132548
    },
    "İzmir:Seferihisar": {
        "id": 1611,
        "population": 63712
    },
    "İzmir:Selçuk": {
        "id": 1612,
        "population": 38578
    },
    "İzmir:Tire": {
        "id": 1677,
        "population": 87571
    },
    "İzmir:Torbalı": {
        "id": 1682,
        "population": 224133
    },
    "İzmir:Urla": {
        "id": 1703,
        "population": 82021
    },
    "Kahramanmaraş:Afşin": {
        "id": 1107,
        "population": 80124
    },
    "Kahramanmaraş:Andırın": {
        "id": 1136,
        "population": 31609
    },
    "Kahramanmaraş:Çağlayancerit": {
        "id": 1785,
        "population": 22440
    },
    "Kahramanmaraş:Dulkadiroğlu": {
        "id": 2084,
        "population": 213930
    },
    "Kahramanmaraş:Ekinözü": {
        "id": 1919,
        "population": 9896
    },
    "Kahramanmaraş:Elbistan": {
        "id": 1299,
        "population": 132036
    },
    "Kahramanmaraş:Göksun": {
        "id": 1353,
        "population": 49145
    },
    "Kahramanmaraş:Nurhak": {
        "id": 1975,
        "population": 11675
    },
    "Kahramanmaraş:Onikişubat": {
        "id": 2085,
        "population": 447591
    },
    "Kahramanmaraş:Pazarcık": {
        "id": 1570,
        "population": 66777
    },
    "Kahramanmaraş:Türkoğlu": {
        "id": 1694,
        "population": 81055
    },
    "Karabük:Eflani": {
        "id": 1296,
        "population": 8663
    },
    "Karabük:Eskipazar": {
        "id": 1321,
        "population": 12570
    },
    "Karabük:Merkez": {
        "id": 1433,
        "population": 135819
    },
    "Karabük:Ovacık": {
        "id": 1561,
        "population": 3986
    },
    "Karabük:Safranbolu": {
        "id": 1587,
        "population": 69592
    },
    "Karabük:Yenice": {
        "id": 1856,
        "population": 18984
    },
    "Karaman:Ayrancı": {
        "id": 1768,
        "population": 7127
    },
    "Karaman:Başyayla": {
        "id": 1884,
        "population": 3353
    },
    "Karaman:Ermenek": {
        "id": 1316,
        "population": 27629
    },
    "Karaman:Kazımkarabekir": {
        "id": 1862,
        "population": 4679
    },
    "Karaman:Merkez": {
        "id": 1439,
        "population": 207973
    },
    "Karaman:Sarıveliler": {
        "id": 1983,
        "population": 11594
    },
    "Kars:Akyaka": {
        "id": 1756,
        "population": 9382
    },
    "Kars:Arpaçay": {
        "id": 1149,
        "population": 13770
    },
    "Kars:Digor": {
        "id": 1279,
        "population": 17557
    },
    "Kars:Kağızman": {
        "id": 1424,
        "population": 42717
    },
    "Kars:Merkez": {
        "id": 1447,
        "population": 121154
    },
    "Kars:Sarıkamış": {
        "id": 1601,
        "population": 35518
    },
    "Kars:Selim": {
        "id": 1614,
        "population": 20476
    },
    "Kars:Susuz": {
        "id": 1645,
        "population": 8417
    },
    "Kastamonu:Abana": {
        "id": 1101,
        "population": 4474
    },
    "Kastamonu:Ağlı": {
        "id": 1867,
        "population": 3176
    },
    "Kastamonu:Araç": {
        "id": 1140,
        "population": 18121
    },
    "Kastamonu:Azdavay": {
        "id": 1162,
        "population": 7266
    },
    "Kastamonu:Bozkurt": {
        "id": 1208,
        "population": 9250
    },
    "Kastamonu:Çatalzeytin": {
        "id": 1238,
        "population": 7185
    },
    "Kastamonu:Cide": {
        "id": 1221,
        "population": 22496
    },
    "Kastamonu:Daday": {
        "id": 1264,
        "population": 7736
    },
    "Kastamonu:Devrekani": {
        "id": 1277,
        "population": 12033
    },
    "Kastamonu:Doğanyurt": {
        "id": 1915,
        "population": 5057
    },
    "Kastamonu:Hanönü": {
        "id": 1940,
        "population": 4286
    },
    "Kastamonu:İhsangazi": {
        "id": 1805,
        "population": 4976
    },
    "Kastamonu:İnebolu": {
        "id": 1410,
        "population": 19678
    },
    "Kastamonu:Küre": {
        "id": 1499,
        "population": 5108
    },
    "Kastamonu:Merkez": {
        "id": 1450,
        "population": 158953
    },
    "Kastamonu:Pınarbaşı": {
        "id": 1836,
        "population": 5782
    },
    "Kastamonu:Şenpazar": {
        "id": 1845,
        "population": 4083
    },
    "Kastamonu:Seydiler": {
        "id": 1984,
        "population": 4639
    },
    "Kastamonu:Taşköprü": {
        "id": 1666,
        "population": 36544
    },
    "Kastamonu:Tosya": {
        "id": 1685,
        "population": 39091
    },
    "Kayseri:Akkışla": {
        "id": 1752,
        "population": 5440
    },
    "Kayseri:Bünyan": {
        "id": 1218,
        "population": 30362
    },
    "Kayseri:Develi": {
        "id": 1275,
        "population": 67818
    },
    "Kayseri:Felahiye": {
        "id": 1330,
        "population": 5529
    },
    "Kayseri:Hacılar": {
        "id": 1936,
        "population": 13701
    },
    "Kayseri:İncesu": {
        "id": 1409,
        "population": 29780
    },
    "Kayseri:Kocasinan": {
        "id": 1863,
        "population": 421472
    },
    "Kayseri:Melikgazi": {
        "id": 1864,
        "population": 593262
    },
    "Kayseri:Özvatan": {
        "id": 1978,
        "population": 3877
    },
    "Kayseri:Pınarbaşı": {
        "id": 1576,
        "population": 20598
    },
    "Kayseri:Sarıoğlan": {
        "id": 1603,
        "population": 13510
    },
    "Kayseri:Sarız": {
        "id": 1605,
        "population": 9213
    },
    "Kayseri:Talas": {
        "id": 1846,
        "population": 173657
    },
    "Kayseri:Tomarza": {
        "id": 1680,
        "population": 20156
    },
    "Kayseri:Yahyalı": {
        "id": 1715,
        "population": 35207
    },
    "Kayseri:Yeşilhisar": {
        "id": 1727,
        "population": 15409
    },
    "Kilis:Elbeyli": {
        "id": 2023,
        "population": 5273
    },
    "Kilis:Merkez": {
        "id": 1476,
        "population": 135430
    },
    "Kilis:Musabeyli": {
        "id": 2024,
        "population": 11692
    },
    "Kilis:Polateli": {
        "id": 2025,
        "population": 4968
    },
    "Kırıkkale:Bahşılı": {
        "id": 1880,
        "population": 7353
    },
    "Kırıkkale:Balışeyh": {
        "id": 1882,
        "population": 5888
    },
    "Kırıkkale:Çelebi": {
        "id": 1901,
        "population": 2587
    },
    "Kırıkkale:Delice": {
        "id": 1268,
        "population": 10577
    },
    "Kırıkkale:Karakeçili": {
        "id": 1954,
        "population": 3062
    },
    "Kırıkkale:Keskin": {
        "id": 1463,
        "population": 15841
    },
    "Kırıkkale:Merkez": {
        "id": 1469,
        "population": 192821
    },
    "Kırıkkale:Sulakyurt": {
        "id": 1638,
        "population": 5564
    },
    "Kırıkkale:Yahşihan": {
        "id": 1992,
        "population": 39137
    },
    "Kırklareli:Babaeski": {
        "id": 1163,
        "population": 46355
    },
    "Kırklareli:Demirköy": {
        "id": 1270,
        "population": 9364
    },
    "Kırklareli:Kofçaz": {
        "id": 1480,
        "population": 2291
    },
    "Kırklareli:Lüleburgaz": {
        "id": 1505,
        "population": 157136
    },
    "Kırklareli:Merkez": {
        "id": 1471,
        "population": 114710
    },
    "Kırklareli:Pehlivanköy": {
        "id": 1572,
        "population": 3276
    },
    "Kırklareli:Pınarhisar": {
        "id": 1577,
        "population": 17694
    },
    "Kırklareli:Vize": {
        "id": 1714,
        "population": 28769
    },
    "Kırşehir:Akçakent": {
        "id": 1869,
        "population": 3301
    },
    "Kırşehir:Akpınar": {
        "id": 1754,
        "population": 6435
    },
    "Kırşehir:Boztepe": {
        "id": 1890,
        "population": 5049
    },
    "Kırşehir:Çiçekdağı": {
        "id": 1254,
        "population": 13350
    },
    "Kırşehir:Kaman": {
        "id": 1429,
        "population": 33354
    },
    "Kırşehir:Merkez": {
        "id": 1472,
        "population": 163368
    },
    "Kırşehir:Mucur": {
        "id": 1529,
        "population": 17920
    },
    "Kocaeli:Başiskele": {
        "id": 2058,
        "population": 131387
    },
    "Kocaeli:Çayırova": {
        "id": 2059,
        "population": 162262
    },
    "Kocaeli:Darıca": {
        "id": 2060,
        "population": 235632
    },
    "Kocaeli:Derince": {
        "id": 2030,
        "population": 147892
    },
    "Kocaeli:Dilovası": {
        "id": 2061,
        "population": 55355
    },
    "Kocaeli:Gebze": {
        "id": 1338,
        "population": 414960
    },
    "Kocaeli:Gölcük": {
        "id": 1355,
        "population": 181227
    },
    "Kocaeli:İzmit": {
        "id": 2062,
        "population": 381254
    },
    "Kocaeli:Kandıra": {
        "id": 1430,
        "population": 54260
    },
    "Kocaeli:Karamürsel": {
        "id": 1440,
        "population": 59488
    },
    "Kocaeli:Kartepe": {
        "id": 2063,
        "population": 154377
    },
    "Kocaeli:Körfez": {
        "id": 1821,
        "population": 183077
    },
    "Konya:Ahırlı": {
        "id": 1868,
        "population": 4536
    },
    "Konya:Akören": {
        "id": 1753,
        "population": 5744
    },
    "Konya:Akşehir": {
        "id": 1122,
        "population": 93613
    },
    "Konya:Altınekin": {
        "id": 1760,
        "population": 14374
    },
    "Konya:Beyşehir": {
        "id": 1188,
        "population": 80353
    },
    "Konya:Bozkır": {
        "id": 1207,
        "population": 24704
    },
    "Konya:Çeltik": {
        "id": 1902,
        "population": 9482
    },
    "Konya:Cihanbeyli": {
        "id": 1222,
        "population": 49126
    },
    "Konya:Çumra": {
        "id": 1262,
        "population": 68803
    },
    "Konya:Derbent": {
        "id": 1907,
        "population": 3954
    },
    "Konya:Derebucak": {
        "id": 1789,
        "population": 5353
    },
    "Konya:Doğanhisar": {
        "id": 1285,
        "population": 14097
    },
    "Konya:Emirgazi": {
        "id": 1920,
        "population": 7647
    },
    "Konya:Ereğli": {
        "id": 1312,
        "population": 158010
    },
    "Konya:Güneysınır": {
        "id": 1933,
        "population": 9237
    },
    "Konya:Hadim": {
        "id": 1375,
        "population": 10621
    },
    "Konya:Halkapınar": {
        "id": 1937,
        "population": 3947
    },
    "Konya:Hüyük": {
        "id": 1804,
        "population": 14878
    },
    "Konya:Ilgın": {
        "id": 1400,
        "population": 53167
    },
    "Konya:Kadınhanı": {
        "id": 1422,
        "population": 31478
    },
    "Konya:Karapınar": {
        "id": 1441,
        "population": 51756
    },
    "Konya:Karatay": {
        "id": 1814,
        "population": 395499
    },
    "Konya:Kulu": {
        "id": 1491,
        "population": 51732
    },
    "Konya:Meram": {
        "id": 1827,
        "population": 349685
    },
    "Konya:Sarayönü": {
        "id": 1598,
        "population": 28401
    },
    "Konya:Selçuklu": {
        "id": 1839,
        "population": 703449
    },
    "Konya:Seydişehir": {
        "id": 1617,
        "population": 66079
    },
    "Konya:Taşkent": {
        "id": 1848,
        "population": 5669
    },
    "Konya:Tuzlukçu": {
        "id": 1990,
        "population": 6052
    },
    "Konya:Yalıhüyük": {
        "id": 1994,
        "population": 1704
    },
    "Konya:Yunak": {
        "id": 1735,
        "population": 20259
    },
    "Kütahya:Altıntaş": {
        "id": 1132,
        "population": 14739
    },
    "Kütahya:Aslanapa": {
        "id": 1764,
        "population": 7813
    },
    "Kütahya:Çavdarhisar": {
        "id": 1898,
        "population": 5503
    },
    "Kütahya:Domaniç": {
        "id": 1288,
        "population": 13900
    },
    "Kütahya:Dumlupınar": {
        "id": 1790,
        "population": 2812
    },
    "Kütahya:Emet": {
        "id": 1304,
        "population": 17352
    },
    "Kütahya:Gediz": {
        "id": 1339,
        "population": 48539
    },
    "Kütahya:Hisarcık": {
        "id": 1802,
        "population": 10799
    },
    "Kütahya:Merkez": {
        "id": 1500,
        "population": 277000
    },
    "Kütahya:Pazarlar": {
        "id": 1979,
        "population": 4713
    },
    "Kütahya:Şaphane": {
        "id": 1843,
        "population": 5540
    },
    "Kütahya:Simav": {
        "id": 1625,
        "population": 60886
    },
    "Kütahya:Tavşanlı": {
        "id": 1671,
        "population": 100882
    },
    "Malatya:Akçadağ": {
        "id": 1114,
        "population": 31479
    },
    "Malatya:Arapgir": {
        "id": 1143,
        "population": 9917
    },
    "Malatya:Arguvan": {
        "id": 1148,
        "population": 6859
    },
    "Malatya:Battalgazi": {
        "id": 1772,
        "population": 274563
    },
    "Malatya:Darende": {
        "id": 1265,
        "population": 24806
    },
    "Malatya:Doğanşehir": {
        "id": 1286,
        "population": 36037
    },
    "Malatya:Doğanyol": {
        "id": 1914,
        "population": 4002
    },
    "Malatya:Hekimhan": {
        "id": 1390,
        "population": 17116
    },
    "Malatya:Kale": {
        "id": 1953,
        "population": 7462
    },
    "Malatya:Kuluncak": {
        "id": 1969,
        "population": 7414
    },
    "Malatya:Pütürge": {
        "id": 1582,
        "population": 12372
    },
    "Malatya:Yazıhan": {
        "id": 1995,
        "population": 13937
    },
    "Malatya:Yeşilyurt": {
        "id": 1729,
        "population": 309890
    },
    "Manisa:Ahmetli": {
        "id": 1751,
        "population": 17612
    },
    "Manisa:Akhisar": {
        "id": 1118,
        "population": 181472
    },
    "Manisa:Alaşehir": {
        "id": 1127,
        "population": 104565
    },
    "Manisa:Demirci": {
        "id": 1269,
        "population": 35629
    },
    "Manisa:Gölmarmara": {
        "id": 1793,
        "population": 15140
    },
    "Manisa:Gördes": {
        "id": 1362,
        "population": 25456
    },
    "Manisa:Kırkağaç": {
        "id": 1470,
        "population": 37363
    },
    "Manisa:Köprübaşı": {
        "id": 1965,
        "population": 12217
    },
    "Manisa:Kula": {
        "id": 1489,
        "population": 43015
    },
    "Manisa:Salihli": {
        "id": 1590,
        "population": 165007
    },
    "Manisa:Sarıgöl": {
        "id": 1600,
        "population": 34786
    },
    "Manisa:Saruhanlı": {
        "id": 1606,
        "population": 58475
    },
    "Manisa:Şehzadeler": {
        "id": 2086,
        "population": 168582
    },
    "Manisa:Selendi": {
        "id": 1613,
        "population": 18568
    },
    "Manisa:Soma": {
        "id": 1634,
        "population": 110188
    },
    "Manisa:Turgutlu": {
        "id": 1689,
        "population": 179326
    },
    "Manisa:Yunusemre": {
        "id": 2087,
        "population": 270355
    },
    "Mardin:Artuklu": {
        "id": 2088,
        "population": 198718
    },
    "Mardin:Dargeçit": {
        "id": 1787,
        "population": 26675
    },
    "Mardin:Derik": {
        "id": 1273,
        "population": 61553
    },
    "Mardin:Kızıltepe": {
        "id": 1474,
        "population": 275217
    },
    "Mardin:Mazıdağı": {
        "id": 1519,
        "population": 37381
    },
    "Mardin:Midyat": {
        "id": 1526,
        "population": 125791
    },
    "Mardin:Nusaybin": {
        "id": 1547,
        "population": 119559
    },
    "Mardin:Ömerli": {
        "id": 1564,
        "population": 14112
    },
    "Mardin:Savur": {
        "id": 1609,
        "population": 23404
    },
    "Mardin:Yeşilli": {
        "id": 2002,
        "population": 21166
    },
    "Mersin:Akdeniz": {
        "id": 2064,
        "population": 254292
    },
    "Mersin:Anamur": {
        "id": 1135,
        "population": 66952
    },
    "Mersin:Aydıncık": {
        "id": 1766,
        "population": 11271
    },
    "Mersin:Bozyazı": {
        "id": 1779,
        "population": 26832
    },
    "Mersin:Çamlıyayla": {
        "id": 1892,
        "population": 8383
    },
    "Mersin:Erdemli": {
        "id": 1311,
        "population": 157566
    },
    "Mersin:Gülnar": {
        "id": 1366,
        "population": 32785
    },
    "Mersin:Mezitli": {
        "id": 2065,
        "population": 233140
    },
    "Mersin:Mut": {
        "id": 1536,
        "population": 62758
    },
    "Mersin:Silifke": {
        "id": 1621,
        "population": 139610
    },
    "Mersin:Tarsus": {
        "id": 1665,
        "population": 358510
    },
    "Mersin:Toroslar": {
        "id": 2066,
        "population": 322971
    },
    "Mersin:Yenişehir": {
        "id": 2067,
        "population": 281358
    },
    "Muğla:Bodrum": {
        "id": 1197,
        "population": 207196
    },
    "Muğla:Dalaman": {
        "id": 1742,
        "population": 53327
    },
    "Muğla:Datça": {
        "id": 1266,
        "population": 26067
    },
    "Muğla:Fethiye": {
        "id": 1331,
        "population": 187332
    },
    "Muğla:Kavaklıdere": {
        "id": 1958,
        "population": 10854
    },
    "Muğla:Köyceğiz": {
        "id": 1488,
        "population": 41810
    },
    "Muğla:Marmaris": {
        "id": 1517,
        "population": 97373
    },
    "Muğla:Menteşe": {
        "id": 2089,
        "population": 126288
    },
    "Muğla:Milas": {
        "id": 1528,
        "population": 152275
    },
    "Muğla:Ortaca": {
        "id": 1831,
        "population": 58704
    },
    "Muğla:Seydikemer": {
        "id": 2090,
        "population": 65648
    },
    "Muğla:Ula": {
        "id": 1695,
        "population": 27649
    },
    "Muğla:Yatağan": {
        "id": 1719,
        "population": 45024
    },
    "Muş:Bulanık": {
        "id": 1213,
        "population": 68983
    },
    "Muş:Hasköy": {
        "id": 1801,
        "population": 27684
    },
    "Muş:Korkut": {
        "id": 1964,
        "population": 19251
    },
    "Muş:Malazgirt": {
        "id": 1510,
        "population": 40595
    },
    "Muş:Merkez": {
        "id": 1534,
        "population": 203810
    },
    "Muş:Varto": {
        "id": 1711,
        "population": 28804
    },
    "Nevşehir:Acıgöl": {
        "id": 1749,
        "population": 19430
    },
    "Nevşehir:Avanos": {
        "id": 1155,
        "population": 32093
    },
    "Nevşehir:Derinkuyu": {
        "id": 1274,
        "population": 21107
    },
    "Nevşehir:Gülşehir": {
        "id": 1367,
        "population": 21173
    },
    "Nevşehir:Hacıbektaş": {
        "id": 1374,
        "population": 10564
    },
    "Nevşehir:Kozaklı": {
        "id": 1485,
        "population": 12678
    },
    "Nevşehir:Merkez": {
        "id": 1543,
        "population": 163126
    },
    "Nevşehir:Ürgüp": {
        "id": 1707,
        "population": 39979
    },
    "Niğde:Altunhisar": {
        "id": 1876,
        "population": 12004
    },
    "Niğde:Bor": {
        "id": 1201,
        "population": 62594
    },
    "Niğde:Çamardı": {
        "id": 1225,
        "population": 11631
    },
    "Niğde:Çiftlik": {
        "id": 1904,
        "population": 25157
    },
    "Niğde:Merkez": {
        "id": 1544,
        "population": 244326
    },
    "Niğde:Ulukışla": {
        "id": 1700,
        "population": 18780
    },
    "Ordu:Akkuş": {
        "id": 1119,
        "population": 20465
    },
    "Ordu:Altınordu": {
        "id": 2103,
        "population": 239714
    },
    "Ordu:Aybastı": {
        "id": 1158,
        "population": 19784
    },
    "Ordu:Çamaş": {
        "id": 1891,
        "population": 8407
    },
    "Ordu:Çatalpınar": {
        "id": 1897,
        "population": 12888
    },
    "Ordu:Çaybaşı": {
        "id": 1900,
        "population": 11656
    },
    "Ordu:Fatsa": {
        "id": 1328,
        "population": 129844
    },
    "Ordu:Gölköy": {
        "id": 1358,
        "population": 24780
    },
    "Ordu:Gülyalı": {
        "id": 1795,
        "population": 8881
    },
    "Ordu:Gürgentepe": {
        "id": 1797,
        "population": 12499
    },
    "Ordu:İkizce": {
        "id": 1947,
        "population": 12537
    },
    "Ordu:Kabadüz": {
        "id": 1950,
        "population": 6794
    },
    "Ordu:Kabataş": {
        "id": 1951,
        "population": 9949
    },
    "Ordu:Korgan": {
        "id": 1482,
        "population": 26428
    },
    "Ordu:Kumru": {
        "id": 1493,
        "population": 27638
    },
    "Ordu:Mesudiye": {
        "id": 1525,
        "population": 11829
    },
    "Ordu:Perşembe": {
        "id": 1573,
        "population": 30053
    },
    "Ordu:Ulubey": {
        "id": 1696,
        "population": 18027
    },
    "Ordu:Ünye": {
        "id": 1706,
        "population": 135914
    },
    "Osmaniye:Bahçe": {
        "id": 1165,
        "population": 22989
    },
    "Osmaniye:Düziçi": {
        "id": 1743,
        "population": 88274
    },
    "Osmaniye:Hasanbeyli": {
        "id": 2027,
        "population": 4914
    },
    "Osmaniye:Kadirli": {
        "id": 1423,
        "population": 127644
    },
    "Osmaniye:Merkez": {
        "id": 1560,
        "population": 284895
    },
    "Osmaniye:Sumbas": {
        "id": 2028,
        "population": 13049
    },
    "Osmaniye:Toprakkale": {
        "id": 2029,
        "population": 22358
    },
    "Rize:Ardeşen": {
        "id": 1146,
        "population": 43519
    },
    "Rize:Çamlıhemşin": {
        "id": 1228,
        "population": 7051
    },
    "Rize:Çayeli": {
        "id": 1241,
        "population": 42032
    },
    "Rize:Derepazarı": {
        "id": 1908,
        "population": 6772
    },
    "Rize:Fındıklı": {
        "id": 1332,
        "population": 16388
    },
    "Rize:Güneysu": {
        "id": 1796,
        "population": 15013
    },
    "Rize:Hemşin": {
        "id": 1943,
        "population": 2299
    },
    "Rize:İkizdere": {
        "id": 1405,
        "population": 6287
    },
    "Rize:İyidere": {
        "id": 1949,
        "population": 8495
    },
    "Rize:Kalkandere": {
        "id": 1428,
        "population": 13350
    },
    "Rize:Merkez": {
        "id": 1586,
        "population": 153597
    },
    "Rize:Pazar": {
        "id": 1569,
        "population": 32144
    },
    "Sakarya:Adapazarı": {
        "id": 2068,
        "population": 284006
    },
    "Sakarya:Akyazı": {
        "id": 1123,
        "population": 99561
    },
    "Sakarya:Arifiye": {
        "id": 2069,
        "population": 55589
    },
    "Sakarya:Erenler": {
        "id": 2070,
        "population": 92549
    },
    "Sakarya:Ferizli": {
        "id": 1925,
        "population": 36015
    },
    "Sakarya:Geyve": {
        "id": 1351,
        "population": 51708
    },
    "Sakarya:Hendek": {
        "id": 1391,
        "population": 93990
    },
    "Sakarya:Karapürçek": {
        "id": 1955,
        "population": 13734
    },
    "Sakarya:Karasu": {
        "id": 1442,
        "population": 75887
    },
    "Sakarya:Kaynarca": {
        "id": 1453,
        "population": 25440
    },
    "Sakarya:Kocaali": {
        "id": 1818,
        "population": 24966
    },
    "Sakarya:Pamukova": {
        "id": 1833,
        "population": 31536
    },
    "Sakarya:Sapanca": {
        "id": 1595,
        "population": 47505
    },
    "Sakarya:Serdivan": {
        "id": 2071,
        "population": 168855
    },
    "Sakarya:Söğütlü": {
        "id": 1986,
        "population": 15288
    },
    "Sakarya:Taraklı": {
        "id": 1847,
        "population": 7064
    },
    "Samsun:19 Mayıs": {
        "id": 1830,
        "population": 28658
    },
    "Samsun:Alaçam": {
        "id": 1125,
        "population": 24560
    },
    "Samsun:Asarcık": {
        "id": 1763,
        "population": 15673
    },
    "Samsun:Atakum": {
        "id": 2072,
        "population": 261809
    },
    "Samsun:Ayvacık": {
        "id": 1879,
        "population": 18557
    },
    "Samsun:Bafra": {
        "id": 1164,
        "population": 143387
    },
    "Samsun:Canik": {
        "id": 2073,
        "population": 100247
    },
    "Samsun:Çarşamba": {
        "id": 1234,
        "population": 143206
    },
    "Samsun:Havza": {
        "id": 1386,
        "population": 38103
    },
    "Samsun:İlkadım": {
        "id": 2074,
        "population": 330290
    },
    "Samsun:Kavak": {
        "id": 1452,
        "population": 25370
    },
    "Samsun:Ladik": {
        "id": 1501,
        "population": 15942
    },
    "Samsun:Salıpazarı": {
        "id": 1838,
        "population": 19406
    },
    "Samsun:Tekkeköy": {
        "id": 1849,
        "population": 59356
    },
    "Samsun:Terme": {
        "id": 1676,
        "population": 71348
    },
    "Samsun:Vezirköprü": {
        "id": 1712,
        "population": 87575
    },
    "Samsun:Yakakent": {
        "id": 1993,
        "population": 8916
    },
    "Şanlıurfa:Akçakale": {
        "id": 1115,
        "population": 131351
    },
    "Şanlıurfa:Birecik": {
        "id": 1194,
        "population": 91837
    },
    "Şanlıurfa:Bozova": {
        "id": 1209,
        "population": 50534
    },
    "Şanlıurfa:Ceylanpınar": {
        "id": 1220,
        "population": 93105
    },
    "Şanlıurfa:Eyyübiye": {
        "id": 2091,
        "population": 414516
    },
    "Şanlıurfa:Halfeti": {
        "id": 1378,
        "population": 41624
    },
    "Şanlıurfa:Haliliye": {
        "id": 2092,
        "population": 395975
    },
    "Şanlıurfa:Harran": {
        "id": 1800,
        "population": 101710
    },
    "Şanlıurfa:Hilvan": {
        "id": 1393,
        "population": 41969
    },
    "Şanlıurfa:Karaköprü": {
        "id": 2093,
        "population": 312031
    },
    "Şanlıurfa:Siverek": {
        "id": 1630,
        "population": 277399
    },
    "Şanlıurfa:Suruç": {
        "id": 1643,
        "population": 98022
    },
    "Şanlıurfa:Viranşehir": {
        "id": 1713,
        "population": 215727
    },
    "Siirt:Baykan": {
        "id": 1179,
        "population": 23219
    },
    "Siirt:Eruh": {
        "id": 1317,
        "population": 18339
    },
    "Siirt:Kurtalan": {
        "id": 1495,
        "population": 60674
    },
    "Siirt:Merkez": {
        "id": 1620,
        "population": 180837
    },
    "Siirt:Pervari": {
        "id": 1575,
        "population": 26437
    },
    "Siirt:Şirvan": {
        "id": 1662,
        "population": 18773
    },
    "Siirt:Tillo": {
        "id": 1878,
        "population": 4090
    },
    "Sinop:Ayancık": {
        "id": 1156,
        "population": 23818
    },
    "Sinop:Boyabat": {
        "id": 1204,
        "population": 44901
    },
    "Sinop:Dikmen": {
        "id": 1910,
        "population": 4810
    },
    "Sinop:Durağan": {
        "id": 1290,
        "population": 16788
    },
    "Sinop:Erfelek": {
        "id": 1314,
        "population": 12565
    },
    "Sinop:Gerze": {
        "id": 1349,
        "population": 30701
    },
    "Sinop:Merkez": {
        "id": 1627,
        "population": 70311
    },
    "Sinop:Saraydüzü": {
        "id": 1981,
        "population": 5656
    },
    "Sinop:Türkeli": {
        "id": 1693,
        "population": 16298
    },
    "Şırnak:Beytüşşebap": {
        "id": 1189,
        "population": 13971
    },
    "Şırnak:Cizre": {
        "id": 1223,
        "population": 166290
    },
    "Şırnak:Güçlükonak": {
        "id": 1931,
        "population": 12562
    },
    "Şırnak:İdil": {
        "id": 1403,
        "population": 76548
    },
    "Şırnak:Merkez": {
        "id": 1661,
        "population": 105697
    },
    "Şırnak:Silopi": {
        "id": 1623,
        "population": 152610
    },
    "Şırnak:Uludere": {
        "id": 1698,
        "population": 45988
    },
    "Sivas:Akıncılar": {
        "id": 1870,
        "population": 4641
    },
    "Sivas:Altınyayla": {
        "id": 1875,
        "population": 8245
    },
    "Sivas:Divriği": {
        "id": 1282,
        "population": 15657
    },
    "Sivas:Doğanşar": {
        "id": 1913,
        "population": 2770
    },
    "Sivas:Gemerek": {
        "id": 1342,
        "population": 21342
    },
    "Sivas:Gölova": {
        "id": 1927,
        "population": 2998
    },
    "Sivas:Gürün": {
        "id": 1373,
        "population": 17062
    },
    "Sivas:Hafik": {
        "id": 1376,
        "population": 8950
    },
    "Sivas:İmranlı": {
        "id": 1407,
        "population": 6788
    },
    "Sivas:Kangal": {
        "id": 1431,
        "population": 19406
    },
    "Sivas:Koyulhisar": {
        "id": 1484,
        "population": 11782
    },
    "Sivas:Merkez": {
        "id": 1628,
        "population": 393912
    },
    "Sivas:Şarkışla": {
        "id": 1650,
        "population": 37282
    },
    "Sivas:Suşehri": {
        "id": 1646,
        "population": 25056
    },
    "Sivas:Ulaş": {
        "id": 1991,
        "population": 7603
    },
    "Sivas:Yıldızeli": {
        "id": 1731,
        "population": 26567
    },
    "Sivas:Zara": {
        "id": 1738,
        "population": 21340
    },
    "Tekirdağ:Çerkezköy": {
        "id": 1250,
        "population": 223975
    },
    "Tekirdağ:Çorlu": {
        "id": 1258,
        "population": 306939
    },
    "Tekirdağ:Ergene": {
        "id": 2094,
        "population": 68648
    },
    "Tekirdağ:Hayrabolu": {
        "id": 1388,
        "population": 29706
    },
    "Tekirdağ:Kapaklı": {
        "id": 2095,
        "population": 152509
    },
    "Tekirdağ:Malkara": {
        "id": 1511,
        "population": 50123
    },
    "Tekirdağ:Marmaraereğlisi": {
        "id": 1825,
        "population": 33623
    },
    "Tekirdağ:Muratlı": {
        "id": 1538,
        "population": 30410
    },
    "Tekirdağ:Saray": {
        "id": 1596,
        "population": 51468
    },
    "Tekirdağ:Şarköy": {
        "id": 1652,
        "population": 34458
    },
    "Tekirdağ:Süleymanpaşa": {
        "id": 2096,
        "population": 226582
    },
    "Tokat:Almus": {
        "id": 1129,
        "population": 28135
    },
    "Tokat:Artova": {
        "id": 1151,
        "population": 7589
    },
    "Tokat:Başçiftlik": {
        "id": 1883,
        "population": 8445
    },
    "Tokat:Erbaa": {
        "id": 1308,
        "population": 103409
    },
    "Tokat:Merkez": {
        "id": 1679,
        "population": 201969
    },
    "Tokat:Niksar": {
        "id": 1545,
        "population": 63594
    },
    "Tokat:Pazar": {
        "id": 1834,
        "population": 12875
    },
    "Tokat:Reşadiye": {
        "id": 1584,
        "population": 43108
    },
    "Tokat:Sulusaray": {
        "id": 1987,
        "population": 6536
    },
    "Tokat:Turhal": {
        "id": 1690,
        "population": 77707
    },
    "Tokat:Yeşilyurt": {
        "id": 1858,
        "population": 8045
    },
    "Tokat:Zile": {
        "id": 1740,
        "population": 52729
    },
    "Trabzon:Akçaabat": {
        "id": 1113,
        "population": 131162
    },
    "Trabzon:Araklı": {
        "id": 1141,
        "population": 49230
    },
    "Trabzon:Arsin": {
        "id": 1150,
        "population": 31493
    },
    "Trabzon:Beşikdüzü": {
        "id": 1775,
        "population": 23246
    },
    "Trabzon:Çarşıbaşı": {
        "id": 1896,
        "population": 15004
    },
    "Trabzon:Çaykara": {
        "id": 1244,
        "population": 12921
    },
    "Trabzon:Dernekpazarı": {
        "id": 1909,
        "population": 3717
    },
    "Trabzon:Düzköy": {
        "id": 1917,
        "population": 13105
    },
    "Trabzon:Hayrat": {
        "id": 1942,
        "population": 7410
    },
    "Trabzon:Köprübaşı": {
        "id": 1966,
        "population": 4271
    },
    "Trabzon:Maçka": {
        "id": 1507,
        "population": 24931
    },
    "Trabzon:Of": {
        "id": 1548,
        "population": 43591
    },
    "Trabzon:Ortahisar": {
        "id": 2097,
        "population": 335116
    },
    "Trabzon:Şalpazarı": {
        "id": 1842,
        "population": 10575
    },
    "Trabzon:Sürmene": {
        "id": 1647,
        "population": 25281
    },
    "Trabzon:Tonya": {
        "id": 1681,
        "population": 13332
    },
    "Trabzon:Vakfıkebir": {
        "id": 1709,
        "population": 27278
    },
    "Trabzon:Yomra": {
        "id": 1732,
        "population": 51660
    },
    "Tunceli:Çemişgezek": {
        "id": 1247,
        "population": 7505
    },
    "Tunceli:Hozat": {
        "id": 1397,
        "population": 5332
    },
    "Tunceli:Mazgirt": {
        "id": 1518,
        "population": 7257
    },
    "Tunceli:Merkez": {
        "id": 1688,
        "population": 41045
    },
    "Tunceli:Nazımiye": {
        "id": 1541,
        "population": 3095
    },
    "Tunceli:Ovacık": {
        "id": 1562,
        "population": 6700
    },
    "Tunceli:Pertek": {
        "id": 1574,
        "population": 10569
    },
    "Tunceli:Pülümür": {
        "id": 1581,
        "population": 3580
    },
    "Uşak:Banaz": {
        "id": 1170,
        "population": 34624
    },
    "Uşak:Eşme": {
        "id": 1323,
        "population": 34444
    },
    "Uşak:Karahallı": {
        "id": 1436,
        "population": 9408
    },
    "Uşak:Merkez": {
        "id": 1704,
        "population": 265371
    },
    "Uşak:Sivaslı": {
        "id": 1629,
        "population": 19193
    },
    "Uşak:Ulubey": {
        "id": 1697,
        "population": 11365
    },
    "Van:Bahçesaray": {
        "id": 1770,
        "population": 11438
    },
    "Van:Başkale": {
        "id": 1175,
        "population": 37568
    },
    "Van:Çaldıran": {
        "id": 1786,
        "population": 50170
    },
    "Van:Çatak": {
        "id": 1236,
        "population": 16361
    },
    "Van:Edremit": {
        "id": 1918,
        "population": 132309
    },
    "Van:Erciş": {
        "id": 1309,
        "population": 169040
    },
    "Van:Gevaş": {
        "id": 1350,
        "population": 26253
    },
    "Van:Gürpınar": {
        "id": 1372,
        "population": 28505
    },
    "Van:İpekyolu": {
        "id": 2098,
        "population": 362816
    },
    "Van:Muradiye": {
        "id": 1533,
        "population": 41402
    },
    "Van:Özalp": {
        "id": 1565,
        "population": 51357
    },
    "Van:Saray": {
        "id": 1980,
        "population": 17036
    },
    "Van:Tuşba": {
        "id": 2099,
        "population": 167758
    },
    "Yalova:Altınova": {
        "id": 2019,
        "population": 35490
    },
    "Yalova:Armutlu": {
        "id": 2020,
        "population": 11984
    },
    "Yalova:Çiftlikköy": {
        "id": 2022,
        "population": 58589
    },
    "Yalova:Çınarcık": {
        "id": 2021,
        "population": 40174
    },
    "Yalova:Merkez": {
        "id": 1716,
        "population": 157901
    },
    "Yalova:Termal": {
        "id": 2026,
        "population": 7497
    },
    "Yozgat:Akdağmadeni": {
        "id": 1117,
        "population": 39642
    },
    "Yozgat:Aydıncık": {
        "id": 1877,
        "population": 9317
    },
    "Yozgat:Boğazlıyan": {
        "id": 1198,
        "population": 35316
    },
    "Yozgat:Çandır": {
        "id": 1895,
        "population": 4360
    },
    "Yozgat:Çayıralan": {
        "id": 1242,
        "population": 11777
    },
    "Yozgat:Çekerek": {
        "id": 1245,
        "population": 18426
    },
    "Yozgat:Kadışehri": {
        "id": 1952,
        "population": 9854
    },
    "Yozgat:Merkez": {
        "id": 1733,
        "population": 109042
    },
    "Yozgat:Saraykent": {
        "id": 1982,
        "population": 12605
    },
    "Yozgat:Sarıkaya": {
        "id": 1602,
        "population": 30785
    },
    "Yozgat:Şefaatli": {
        "id": 1655,
        "population": 14008
    },
    "Yozgat:Sorgun": {
        "id": 1635,
        "population": 80068
    },
    "Yozgat:Yenifakılı": {
        "id": 1998,
        "population": 5008
    },
    "Yozgat:Yerköy": {
        "id": 1726,
        "population": 33000
    },
    "Zonguldak:Alaplı": {
        "id": 1758,
        "population": 43217
    },
    "Zonguldak:Çaycuma": {
        "id": 1240,
        "population": 91796
    },
    "Zonguldak:Devrek": {
        "id": 1276,
        "population": 56900
    },
    "Zonguldak:Ereğli": {
        "id": 1313,
        "population": 173884
    },
    "Zonguldak:Gökçebey": {
        "id": 1926,
        "population": 21070
    },
    "Zonguldak:Kilimli": {
        "id": 2100,
        "population": 32441
    },
    "Zonguldak:Kozlu": {
        "id": 2101,
        "population": 50616
    },
    "Zonguldak:Merkez": {
        "id": 1741,
        "population": 115279
    }
}


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


def get_district_id(city_name: str, district_name: str) -> Optional[int]:
    """Returns the official district ID for the city and district name."""
    norm_c = normalize_turkish(city_name)
    norm_d = normalize_turkish(district_name)
    for k, v in DISTRICT_METRICS.items():
        c, d = k.split(":", 1)
        if normalize_turkish(c) == norm_c and normalize_turkish(d) == norm_d:
            return v["id"]
    return None


def get_district_population(city_name: str, district_name: str) -> int:
    """Returns the official population for the given city and district."""
    norm_c = normalize_turkish(city_name)
    norm_d = normalize_turkish(district_name)
    for k, v in DISTRICT_METRICS.items():
        c, d = k.split(":", 1)
        if normalize_turkish(c) == norm_c and normalize_turkish(d) == norm_d:
            return v.get("population", 0)
    return 0


def format_population(num: Optional[int]) -> str:
    """Formats population count cleanly (e.g. 450000 -> '450K', 1200000 -> '1.2M')."""
    if not num or num <= 0:
        return ""
    if num >= 1_000_000:
        return f"{num / 1_000_000:.1f}M"
    if num >= 1_000:
        return f"{num // 1_000}K"
    return str(num)


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
