"""
Turkish District Neighborhoods & Subdivisions Dataset.
Provides data-driven sub-area seeds for local discovery query generation across Turkish cities.
"""
from typing import Dict, List, Optional
from backend.app.data.turkey_locations import normalize_turkish

# Data-driven mappings for major districts and their key commercial / residential neighborhoods
TURKEY_DISTRICT_SUBDIVISIONS: Dict[str, Dict[str, List[str]]] = {
    "istanbul": {
        "atasehir": [
            "Yenişehir", "Barbaros", "İçerenköy", "Küçükbakkalköy", "Atatürk", "Kayışdağı",
            "Batı Ataşehir", "Örnek", "Esatpaşa", "Fetih", "Mevlana", "Ferhatpaşa",
            "Yenisahra", "İnönü", "Mustafa Kemal", "Yeni Çamlıca", "Aşıkveysel", "Mimar Sinan"
        ],
        "umraniye": [
            "Dudullu", "İmes", "Modoko", "Atakent", "Ihlamurkuyu",
            "İstiklal", "Armağanevler", "Çakmak", "Esenkent", "Şerifali", "Yukarı Dudullu"
        ],
        "kadikoy": [
            "Moda", "Caddebostan", "Suadiye", "Bostancı", "Fenerbahçe",
            "Göztepe", "Erenköy", "Kozyatağı", "Rasimpaşa", "Sahrayıcedit", "Acıbadem"
        ],
        "besiktas": [
            "Levent", "Etiler", "Bebek", "Ortaköy", "Gayrettepe",
            "Arnavutköy", "Abbasağa", "Dikilitaş", "Sinanpaşa", "Yıldız", "Balmumcu"
        ],
        "sisli": [
            "Mecidiyeköy", "Nişantaşı", "Fulya", "Halaskargazi", "Teşvikiye",
            "Kurtuluş", "Esentepe", "Gülbahar", "Feriköy", "Pangaltı", "Bomonti"
        ],
        "bakirkoy": [
            "Yeşilköy", "Florya", "Ataköy", "Zuhuratbaba", "Kartaltepe", "Osmaniye", "Yeşilyurt"
        ],
        "uskudar": [
            "Altunizade", "Acıbadem", "Beylerbeyi", "Çengelköy", "Kuzguncuk", "Bağlarbaşı", "Ünalan"
        ],
        "maltepe": [
            "Küçükyalı", "İdealtepe", "Altayçeşme", "Bağlarbaşı", "Cevizli", "Zümrütevler"
        ],
        "pendik": [
            "Kurtköy", "Kaynarca", "Yenişehir", "Güzelyalı", "Batı", "Çamlık"
        ],
        "kartal": [
            "Soğanlık", "Cevizli", "Uğur Mumcu", "Atalar", "Kordonboyu", "Petrol İş"
        ],
        "sariyer": [
            "Maslak", "Tarabya", "İstinye", "Yeniköy", "Ayazağa", "Reşitpaşa", "Zekeriyaköy"
        ]
    },
    "ankara": {
        "cankaya": [
            "Kızılay", "Tunalı", "Çayyolu", "Ümitköy", "Balgat",
            "Bahçelievler", "Kavaklıdere", "Gaziosmanpaşa", "Söğütözü", "Oran"
        ],
        "yenimahalle": [
            "Batıkent", "Demetevler", "Ostim", "İvedik", "Şentepe", "Gimat"
        ],
        "kecioren": [
            "Etlik", "İncirli", "Aktepe", "Uyanış", "Bağlum", "Sanatoryum"
        ]
    },
    "izmir": {
        "konak": [
            "Alsancak", "Göztepe", "Güzelyalı", "Basmane", "Kemeraltı", "Kahramanlar", "Hatay"
        ],
        "bornova": [
            "Küçükpark", "Büyükpark", "Kazımdirik", "Özkanlar", "Evka 3", "Işıklar", "Çamdibi"
        ],
        "karsiyaka": [
            "Bostanlı", "Mavişehir", "Alaybey", "Aksoy", "Bahçelievler", "Donanmacı"
        ]
    },
    "bursa": {
        "nilufer": [
            "Görükle", "Özlüce", "İhsaniye", "Beşevler", "Fethiye", "Ataevler", "Altınşehir"
        ],
        "osmangazi": [
            "Heykel", "Çekirge", "Kükürtlü", "Altıparmak", "Muradiye", "Demirtaş"
        ]
    }
}


def get_subdivisions_for_district(city_name: str, district_name: str) -> List[str]:
    """
    Returns data-driven neighborhoods / sub-areas for a given city and district.
    Returns generic center/regional fallback if specific district mapping is not present.
    """
    norm_city = normalize_turkish(city_name)
    norm_district = normalize_turkish(district_name)

    city_data = TURKEY_DISTRICT_SUBDIVISIONS.get(norm_city)
    if city_data:
        subs = city_data.get(norm_district)
        if subs:
            return list(subs)

    # Generic fallback subdivisions
    return ["Merkez", "Sanayi", "Çarşı"]


def register_subdivisions_for_district(city_name: str, district_name: str, neighborhoods: List[str]) -> None:
    """Registers dynamic or live-fetched neighborhoods into the subdivision registry."""
    if not city_name or not district_name or not neighborhoods:
        return
    norm_city = normalize_turkish(city_name)
    norm_district = normalize_turkish(district_name)
    if norm_city not in TURKEY_DISTRICT_SUBDIVISIONS:
        TURKEY_DISTRICT_SUBDIVISIONS[norm_city] = {}
    existing = TURKEY_DISTRICT_SUBDIVISIONS[norm_city].get(norm_district, [])
    merged = list(dict.fromkeys(existing + neighborhoods))
    TURKEY_DISTRICT_SUBDIVISIONS[norm_city][norm_district] = merged
