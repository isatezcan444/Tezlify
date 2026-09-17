"""
Static B2B Industry & Category Taxonomy Definitions.
Maintains curated Turkish & English keywords, directory category slugs,
text search terms, and OpenStreetMap (OSM) amenity/shop tags.
Decoupled from QueryExpander logic to cleanly separate static data
from expansion and normalization algorithms.
"""
from typing import Dict, List

CATEGORY_TAXONOMY: Dict[str, Dict[str, List[str]]] = {
    "sac_ekim": {
        "keywords": [
            "saç", "sac", "ekim", "ekimi", "transplant", "hair", "trikoloji"
        ],
        "directory_slugs": [
            "saç-ekimi",
            "saç-ekim-merkezi",
            "saç-ekimi-ve-tedavisi",
            "estetik-merkezleri",
            "poliklinikler",
            "tıp-merkezleri",
            "klinikler"
        ],
        "text_terms": [
            "saç ekim merkezi",
            "saç ekimi kliniği",
            "saç ekim",
            "saç ekimi ve tedavisi",
            "hair transplant clinic",
            "estetik ve saç ekimi",
            "poliklinik saç ekim",
            "saç tasarım merkezi"
        ],
        "osm_amenities": [
            "clinic", "hospital", "beauty", "hairdresser", "doctors", "healthcare"
        ]
    },
    "dis_klinigi": {
        "keywords": [
            "diş", "dis", "dent", "dental", "ortodonti", "periodontoloji", "ağız"
        ],
        "directory_slugs": [
            "diş-hekimleri",
            "diş-klinikleri",
            "ağız-ve-diş-sağlığı-merkezleri",
            "diş-poliklinikleri",
            "ortodonti-uzmanları",
            "diş-hastaneleri"
        ],
        "text_terms": [
            "diş kliniği",
            "ağız ve diş sağlığı",
            "diş hekimi",
            "dental klinik",
            "diş polikliniği",
            "dentist clinic",
            "ortodonti kliniği"
        ],
        "osm_amenities": [
            "dentist", "clinic", "hospital", "healthcare", "doctors"
        ]
    },
    "guzellik_estetik": {
        "keywords": [
            "güzellik", "guzellik", "estetik", "kuaför", "kuafor", "spa", "lazer", "epilasyon"
        ],
        "directory_slugs": [
            "güzellik-salonları",
            "estetik-merkezleri",
            "kuaförler",
            "cilt-bakımı",
            "lazer-epilasyon-merkezleri",
            "spa-merkezleri"
        ],
        "text_terms": [
            "güzellik salonu",
            "güzellik merkezi",
            "estetik merkezi",
            "cilt bakımı ve güzellik",
            "lazer epilasyon",
            "beauty salon",
            "kuaför ve güzellik salonu"
        ],
        "osm_amenities": [
            "beauty", "hairdresser", "spa", "cosmetics"
        ]
    },
    "hukuk_avukat": {
        "keywords": [
            "hukuk", "avukat", "baro", "danışmanlık", "arabuluculuk", "dava"
        ],
        "directory_slugs": [
            "avukatlar",
            "hukuk-büroları",
            "arabuluculuk-merkezleri",
            "hukuki-danışmanlık"
        ],
        "text_terms": [
            "hukuk bürosu",
            "avukatlık ofisi",
            "avukat",
            "hukuki danışmanlık",
            "law office",
            "arabuluculuk bürosu"
        ],
        "osm_amenities": [
            "lawyer", "office"
        ]
    },
    "yazilim_ajans": {
        "keywords": [
            "yazılım", "yazilim", "bilişim", "bilisim", "ajans", "medya", "web", "tasarım", "reklam"
        ],
        "directory_slugs": [
            "yazılım-firmaları",
            "reklam-ajansları",
            "web-tasarım",
            "bilişim-firmaları",
            "dijital-pazarlama-ajansları"
        ],
        "text_terms": [
            "yazılım şirketi",
            "dijital reklam ajansı",
            "web tasarım ajansı",
            "bilişim teknolojileri",
            "software company",
            "yazılım ajansı"
        ],
        "osm_amenities": [
            "company", "office", "coworking", "it"
        ]
    },
    "saglik_doktor": {
        "keywords": [
            "sağlık", "saglik", "doktor", "tabip", "klinik", "tıp", "tip", "hastane", "poliklinik"
        ],
        "directory_slugs": [
            "doktorlar",
            "klinikler",
            "tıp-merkezleri",
            "poliklinikler",
            "özel-hastaneler",
            "sağlık-kabini"
        ],
        "text_terms": [
            "özel tıp merkezi",
            "özel poliklinik",
            "sağlık merkezi",
            "özel klinik",
            "doktor muayenehanesi",
            "medical center"
        ],
        "osm_amenities": [
            "doctors", "clinic", "hospital", "pharmacy", "healthcare"
        ]
    },
    "muhasebe_mali": {
        "keywords": [
            "muhasebe", "mali", "müşavir", "musavir", "smmm", "ymm", "vergi", "denetim"
        ],
        "directory_slugs": [
            "mali-müşavirler",
            "muhasebe-büroları",
            "yeminli-mali-müşavirler",
            "denetim-firmaları"
        ],
        "text_terms": [
            "mali müşavirlik",
            "muhasebe bürosu",
            "serbest muhasebeci",
            "smmm ofisi",
            "accounting office"
        ],
        "osm_amenities": [
            "accountant", "office", "financial"
        ]
    }
}
