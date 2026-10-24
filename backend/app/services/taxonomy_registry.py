"""
Relational Category Taxonomy Registry for B2B Lead Intelligence.
Maintains a queryable graph of business categories and semantic relationships:
- IS_A / SUBCATEGORY_OF
- MUTUALLY_EXCLUSIVE
- RELATED_TO / COMPLEMENTARY_TO
"""
import re
import logging
from typing import Dict, Any, List, Optional, Set, Tuple
from backend.app.schemas.intelligence import (
    CategoryNode,
    CategoryRelationship,
    RelationshipType,
    CategoryProfile
)
from backend.app.data.turkey_locations import normalize_turkish

logger = logging.getLogger(__name__)


class TaxonomyRegistry:
    """
    Data-driven Relational Taxonomy Graph:
    Provides graph traversal for category relationships and mutual exclusivity reasoning.
    """

    GENERIC_WORDS: Set[str] = {
        "ilac", "danismanlik", "mutfak", "servis", "tamir", "buro", "merkez",
        "ekipman", "malzeme", "imalat", "dekorasyon"
    }

    _registry: Dict[str, CategoryNode] = {}
    _initialized: bool = False

    @classmethod
    def initialize(cls) -> None:
        """Initializes the standard taxonomy graph with relational nodes."""
        if cls._initialized:
            return

        cls._registry.clear()

        # 1. FURNITURE (Mobilya & Dekorasyon)
        cls.register_node(CategoryNode(
            id="furniture",
            name="furniture",
            display_name="Mobilya & Dekorasyon",
            aliases=[
                "mobilya", "mobilyacı", "mobilyacılar", "mobilya mağazaları", "mobilya mağazası",
                "mobilya imalatı", "mobilya imalatçıları", "mobilya üreticisi", "koltuk", "masa",
                "yatak", "ofis mobilyaları", "mobilya showroom", "furniture", "furniture store"
            ],
            semantic_concepts=[
                "mobilya", "koltuk", "kanepe", "masa", "sandalye", "dolap", "yatak", "baza",
                "ofis mobilyası", "büro mobilyası", "showroom", "mobilya imalatı", "mobilyacı", "furniture",
                "mobilya dekorasyon", "ahşap mobilya", "mutfak dolabı", "gardırop", "sehpa"
            ],
            directory_slugs=[
                "mobilya-magazalari", "mobilya-imalati", "ofis-mobilyalari", "koltuk-doseme",
                "mobilya-ve-dekorasyon", "mobilya-aksesuarlari"
            ],
            osm_shops=["furniture", "interior_decoration"],
            osm_amenities=[],
            relationships=[
                CategoryRelationship(target_category_id="pet_services", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="dental", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="food_beverage", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="bakery", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="legal", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="automotive", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="pharmacy", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="home_decor", relationship_type=RelationshipType.RELATED_TO),
            ]
        ))

        # 2. DENTAL (Diş Klinikleri & Ağız Sağlığı)
        cls.register_node(CategoryNode(
            id="dental",
            name="dental",
            display_name="Diş Klinikleri & Ağız Sağlığı",
            aliases=[
                "diş", "dis", "diş hekimi", "diş hekimleri", "diş klinikleri", "diş kliniği", "ağız ve diş sağlığı",
                "diş polikliniği", "dental", "dentist", "ortodonti", "periodontoloji", "implant"
            ],
            semantic_concepts=[
                "diş", "dis", "dent", "dental", "klinik", "poliklinik", "ortodonti", "implant",
                "ağız ve diş", "diş hekimi", "dentist", "çene cerrahisi", "muayenehane", "pedodonti",
                "endodonti", "endodont", "periodont",
                # G-form inflections: normalize_turkish maps ğ→g, so inflected
                # real-world text ("Polikliniği") never contains the K-forms.
                "klinigi", "poliklinigi",
            ],
            directory_slugs=[
                "diş-hekimleri", "diş-klinikleri", "ağız-ve-diş-sağlığı-merkezleri",
                "diş-poliklinikleri", "ortodonti-uzmanları", "diş-hastaneleri"
            ],
            osm_healthcare=["dentist", "clinic"],
            osm_amenities=["dentist", "clinic", "hospital"],
            relationships=[
                CategoryRelationship(target_category_id="furniture", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="pet_services", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="food_beverage", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="bakery", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="automotive", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                # Beauty/aesthetics/hair-transplant businesses are a distinct
                # industry: their listings must not pass a dental gate even
                # when named "... Poliklinik" (measured: lazer epilasyon rows).
                CategoryRelationship(target_category_id="hair_beauty", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="general_healthcare", relationship_type=RelationshipType.SUBCATEGORY_OF),
            ]
        ))

        # 3. PET SERVICES (Pet Shop & Veteriner)
        cls.register_node(CategoryNode(
            id="pet_services",
            name="pet_services",
            display_name="Pet Shop & Veteriner Klinikleri",
            aliases=[
                "pet shop", "petshop", "pet shoplar", "evcil hayvan", "veteriner", "veteriner kliniği",
                "veteriner klinikleri", "pet kuaför", "kedi köpek maması", "akvaryum",
                "hayvan hastanesi", "hayvan hastaneleri"
            ],
            semantic_concepts=[
                "pet shop", "petshop", "veteriner", "evcil hayvan", "mama", "kedi", "köpek",
                "akvaryum", "kuş", "pet kuaför", "hayvan hastanesi", "pet", "hayvan sağlığı"
            ],
            directory_slugs=[
                "pet-shop", "veteriner-klinikleri", "akvaryumcular", "evcil-hayvan-bakimi"
            ],
            osm_shops=["pet"],
            osm_amenities=["veterinary"],
            relationships=[
                CategoryRelationship(target_category_id="furniture", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="dental", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="food_beverage", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="bakery", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="legal", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
            ]
        ))

        # 4. FOOD & BEVERAGE (Restoranlar & Kafeler)
        cls.register_node(CategoryNode(
            id="food_beverage",
            name="food_beverage",
            display_name="Restoranlar & Yeme-İçme",
            aliases=[
                "restoran", "restoranlar", "lokanta", "lokantalar", "kebapçı", "kafe", "kafeler", "cafe", "bistro",
                "pizzacı", "fast food", "meyhane", "dönerci", "kahve dükkanları"
            ],
            semantic_concepts=[
                "restoran", "restoranlar", "lokanta", "lokantalar", "kafe", "kafeler", "cafe", "kebap", "döner", "yemek", "pizza",
                "burger", "restoran mutfağı", "menü", "ızgara", "lezzet", "restaurant"
            ],
            directory_slugs=[
                "restoranlar", "kafeler", "lokantalar", "kebapcilar", "pizzacilar"
            ],
            osm_amenities=["restaurant", "cafe", "fast_food", "food_court"],
            relationships=[
                CategoryRelationship(target_category_id="furniture", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="dental", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="pet_services", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="legal", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
            ]
        ))

        # 5. BAKERY & PASTRY (Fırın & Pastaneler)
        cls.register_node(CategoryNode(
            id="bakery",
            name="bakery",
            display_name="Fırın & Pastaneler",
            aliases=[
                "fırın", "fırınlar", "pastane", "pastaneler", "pasta dükkanı", "unlu mamuller",
                "tatlıcı", "börekçi", "baklavacı", "bakery", "patisserie"
            ],
            semantic_concepts=[
                "fırın", "pastane", "pasta", "tatlı", "börek", "ekmek", "unlu mamul", "baklava",
                "çörek", "pasta dükkanı", "tasarım pasta", "kurabiye", "bakery", "patisserie"
            ],
            directory_slugs=[
                "pastaneler", "firinlar", "unlu-mamuller", "tatlicilar", "baklavacilar"
            ],
            osm_shops=["bakery", "pastry", "confectionery"],
            osm_amenities=["cafe"],
            relationships=[
                CategoryRelationship(target_category_id="furniture", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="dental", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="pet_services", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="legal", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="food_beverage", relationship_type=RelationshipType.RELATED_TO),
            ]
        ))

        # 6. LEGAL SERVICES (Hukuk & Avukatlık Büroları)
        cls.register_node(CategoryNode(
            id="legal",
            name="legal",
            display_name="Hukuk & Avukatlık Büroları",
            aliases=[
                "avukat", "avukatlar", "avukatlık bürosu", "avukatlık büroları", "hukuk bürosu", "hukuk büroları", "hukuk danışmanlığı",
                "arabuluculuk", "icra", "dava", "hukuk", "law firm"
            ],
            semantic_concepts=[
                "avukat", "hukuk", "dava", "arabulucu", "hukuk danışmanlığı", "hukuk bürosu", "avukatlık bürosu", "baro", "hukukçu",
                "icra", "ceza", "ticaret hukuku", "law", "attorney"
            ],
            directory_slugs=[
                "avukatlar", "hukuk-burolari", "arabuluculuk-merkezleri", "hukuki-danismanlik"
            ],
            osm_amenities=["lawyer", "office"],
            relationships=[
                CategoryRelationship(target_category_id="furniture", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="dental", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="pet_services", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="food_beverage", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
            ]
        ))

        # 7. HAIR & BEAUTY (Kuaförler, Güzellik & Saç Ekim)
        cls.register_node(CategoryNode(
            id="hair_beauty",
            name="hair_beauty",
            display_name="Güzellik, Kuaför & Saç Ekim",
            aliases=[
                "saç ekim", "saç ekimi", "güzellik merkezi", "güzellik merkezleri", "güzellik salonu", "güzellik salonları", "kuaför", "kuaförler",
                "estetik", "cilt bakımı", "lazer epilasyon", "spa"
            ],
            semantic_concepts=[
                "saç ekimi", "güzellik", "estetik", "kuaför", "cilt bakımı", "epilasyon", "lazer",
                "spa", "masaj", "berber", "beauty", "hairdresser"
            ],
            directory_slugs=[
                "saç-ekimi", "güzellik-salonları", "estetik-merkezleri", "kuaförler", "cilt-bakımı"
            ],
            osm_shops=["beauty", "hairdresser"],
            osm_amenities=["spa", "clinic"],
            relationships=[
                CategoryRelationship(target_category_id="furniture", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="pet_services", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="legal", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="dental", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
            ]
        ))

        # 8. AUTOMOTIVE (Otomotiv & Oto Servis)
        cls.register_node(CategoryNode(
            id="automotive",
            name="automotive",
            display_name="Otomotiv & Araç Servisleri",
            aliases=[
                "oto servis", "oto servisleri", "oto tamir", "oto galeri", "araç kiralama", "oto yedek parça",
                "lastikçi", "oto yıkama", "ekspertiz"
            ],
            semantic_concepts=[
                "oto", "otomotiv", "araç", "araba", "oto servis", "oto tamir", "yedek parça", "galeri",
                "lastik", "kaporta", "motor", "ekspertiz"
            ],
            directory_slugs=[
                "oto-tamir-ve-servis", "oto-galerileri", "oto-yedek-parca", "oto-lastik"
            ],
            osm_shops=["car", "car_repair", "car_parts"],
            osm_amenities=["car_wash", "car_rental"],
            relationships=[
                CategoryRelationship(target_category_id="furniture", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="dental", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="bakery", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
            ]
        ))

        # 9. PHARMACY (Eczaneler)
        cls.register_node(CategoryNode(
            id="pharmacy",
            name="pharmacy",
            display_name="Eczaneler",
            aliases=["eczane", "eczaneler", "nöbetçi eczane", "nöbetçi eczaneler", "pharmacy"],
            semantic_concepts=["eczane", "eczaneler", "nöbetçi eczane", "sağlık", "medikal", "pharmacy", "drogerie"],
            directory_slugs=["eczaneler", "nobetci-eczaneler"],
            osm_amenities=["pharmacy"],
            relationships=[
                CategoryRelationship(target_category_id="furniture", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
                CategoryRelationship(target_category_id="automotive", relationship_type=RelationshipType.MUTUALLY_EXCLUSIVE),
            ]
        ))

        cls._initialized = True
        logger.info(f"[TAXONOMY_INIT] Initialized relational taxonomy with {len(cls._registry)} category nodes.")

    @classmethod
    def register_node(cls, node: CategoryNode) -> None:
        """Registers a category node in the taxonomy graph."""
        cls._registry[node.id] = node

    @classmethod
    def get_node(cls, category_id: str) -> Optional[CategoryNode]:
        cls.initialize()
        return cls._registry.get(category_id)

    @classmethod
    def find_node_by_alias_or_concept(cls, query: str) -> Optional[CategoryNode]:
        """
        Finds the best matching CategoryNode in the relational taxonomy using a strict 5-tier matching policy.
        Guarantees that generic single-word commodity/service tokens cannot accidentally select a static node.
        """
        cls.initialize()
        if not query or not query.strip():
            return None

        norm = normalize_turkish(query.strip())
        tokens = set(norm.split())

        # =========================================================================
        # PRIORITY 1: Exact Canonical ID / Display Name Match
        # =========================================================================
        for node in cls._registry.values():
            if (norm == normalize_turkish(node.id) or 
                norm == normalize_turkish(node.name) or 
                norm == normalize_turkish(node.display_name)):
                return node

        # =========================================================================
        # PRIORITY 2: Exact Full Alias Match
        # =========================================================================
        for node in cls._registry.values():
            for alias in node.aliases:
                norm_alias = normalize_turkish(alias)
                if norm == norm_alias:
                    return node

        # =========================================================================
        # PRIORITY 3: Qualified Multi-Token / Phrase Alias Containment
        # Multi-word alias (>= 2 tokens) contained within word boundaries in query
        # =========================================================================
        best_phrase_node: Optional[CategoryNode] = None
        longest_phrase_len = 0
        for node in cls._registry.values():
            for alias in node.aliases:
                norm_alias = normalize_turkish(alias)
                alias_tokens = norm_alias.split()
                if len(alias_tokens) >= 2:
                    if re.search(r'\b' + re.escape(norm_alias) + r'\b', norm):
                        if len(norm_alias) > longest_phrase_len:
                            longest_phrase_len = len(norm_alias)
                            best_phrase_node = node

        if best_phrase_node:
            return best_phrase_node

        # =========================================================================
        # PRIORITY 4: Dominant Primary Single-Word Alias Match
        # Allowed ONLY if single word is NOT in GENERIC_WORDS
        # =========================================================================
        for node in cls._registry.values():
            for alias in node.aliases:
                norm_alias = normalize_turkish(alias)
                alias_tokens = norm_alias.split()
                if len(alias_tokens) == 1:
                    single_word = alias_tokens[0]
                    if single_word in cls.GENERIC_WORDS:
                        continue
                    if re.search(r'\b' + re.escape(single_word) + r'\b', norm):
                        return node

        # =========================================================================
        # PRIORITY 5: Multi-Concept Qualified Semantic Overlap
        # Requires at least 2 distinct domain-specific concept tokens
        # =========================================================================
        best_concept_node: Optional[CategoryNode] = None
        best_concept_overlap_count = 0
        for node in cls._registry.values():
            node_concepts = {
                normalize_turkish(c) for c in node.semantic_concepts 
                if normalize_turkish(c) not in cls.GENERIC_WORDS
            }
            overlap = tokens.intersection(node_concepts)
            if len(overlap) >= 2 and len(overlap) > best_concept_overlap_count:
                best_concept_overlap_count = len(overlap)
                best_concept_node = node

        if best_concept_node:
            return best_concept_node

        # =========================================================================
        # PRIORITY 6: Dynamic Fallback (Safe Default)
        # =========================================================================
        return None

    @classmethod
    def are_mutually_exclusive(cls, cat_a_id: str, cat_b_id: str) -> bool:
        """Determines if two categories have a MUTUALLY_EXCLUSIVE relationship."""
        cls.initialize()
        if not cat_a_id or not cat_b_id or cat_a_id == cat_b_id:
            return False

        node_a = cls._registry.get(cat_a_id)
        if node_a:
            for rel in node_a.relationships:
                if rel.target_category_id == cat_b_id and rel.relationship_type == RelationshipType.MUTUALLY_EXCLUSIVE:
                    return True

        node_b = cls._registry.get(cat_b_id)
        if node_b:
            for rel in node_b.relationships:
                if rel.target_category_id == cat_a_id and rel.relationship_type == RelationshipType.MUTUALLY_EXCLUSIVE:
                    return True

        return False

    @classmethod
    def build_profile_from_node(cls, node: CategoryNode) -> CategoryProfile:
        """Converts a CategoryNode into an operational CategoryProfile with full relational context."""
        cls.initialize()
        exclusive_ids: List[str] = []
        related_ids: List[str] = []

        for rel in node.relationships:
            if rel.relationship_type == RelationshipType.MUTUALLY_EXCLUSIVE:
                exclusive_ids.append(rel.target_category_id)
            elif rel.relationship_type in (RelationshipType.RELATED_TO, RelationshipType.COMPLEMENTARY_TO):
                related_ids.append(rel.target_category_id)

        # Collect negative concepts from mutually exclusive nodes
        negative_concepts: Set[str] = set()
        for ex_id in exclusive_ids:
            ex_node = cls._registry.get(ex_id)
            if ex_node:
                negative_concepts.update(ex_node.semantic_concepts[:10])
                negative_concepts.update(ex_node.aliases[:5])

        return CategoryProfile(
            canonical_id=node.id,
            display_name=node.display_name,
            semantic_description=f"Standard relational taxonomy profile for {node.display_name}",
            profile_version=node.version,
            is_dynamic=False,
            positive_concepts=node.semantic_concepts,
            negative_concepts=list(negative_concepts),
            search_terms=node.aliases[:8],
            directory_slugs=node.directory_slugs,
            osm_amenities=node.osm_amenities,
            osm_shops=node.osm_shops,
            mutually_exclusive_categories=exclusive_ids,
            related_categories=related_ids
        )
