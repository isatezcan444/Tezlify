/**
 * Emoji catalogue for the chat composer.
 *
 * WHY THIS FILE EXISTS INSTEAD OF A PACKAGE
 * -----------------------------------------
 * The frontend dependency list is deliberately small (react, react-dom,
 * lucide-react, clsx, tailwind-merge, cva). The usual emoji pickers on npm ship
 * either the full Unicode CLDR index (hundreds of kB before tree-shaking) or a
 * whole picker UI with its own styling system. Neither is worth a permanent
 * dependency for one panel in one composer, and the panel has to look like the
 * iOS one — a curated grid with a category bar, not a searchable wall of
 * characters.
 *
 * So this is a CURATED set (the emoji people actually send, in the same
 * category order as WhatsApp Web / iOS), each entry carrying its own search
 * vocabulary. Turkish keywords are included because this app is Turkish-first
 * and someone looking for ❤️ types "kalp", not "heart".
 *
 * `searchEmojis` and the recents helpers are pure and storage-injectable, so
 * they are covered by `scripts/verify-emoji-picker.mjs` without a DOM.
 */

export type EmojiCategoryId =
  | 'recent'
  | 'smileys'
  | 'animals'
  | 'food'
  | 'activity'
  | 'travel'
  | 'objects'
  | 'symbols'
  | 'flags';

export interface EmojiEntry {
  /** The emoji character itself. */
  char: string;
  /** Lowercased English name + synonyms, used for search. */
  keywords: string;
  /** Lowercased Turkish synonyms. This app is Turkish-first. */
  tr: string;
}

/** `[char, english keywords, turkish keywords]` — compact enough to read as data. */
type Row = [string, string, string];

const SMILEYS: Row[] = [
  ['😀', 'grinning face smile happy', 'gülen yüz mutlu sırıtma'],
  ['😃', 'grinning face big eyes smile happy', 'gülen yüz mutlu'],
  ['😄', 'grinning face smiling eyes happy laugh', 'gülen yüz gülen gözler mutlu'],
  ['😁', 'beaming face grin happy', 'sırıtan yüz mutlu'],
  ['😆', 'grinning squinting face laugh haha', 'kahkaha gülme komik'],
  ['😅', 'grinning face sweat smile relief', 'terli gülüş rahatlama'],
  ['🤣', 'rolling on the floor laughing rofl lol', 'kahkaha krizi yerlerde'],
  ['😂', 'face with tears of joy laugh cry lol', 'gülmekten ağlamak komik'],
  ['🙂', 'slightly smiling face smile', 'hafif gülümseme'],
  ['🙃', 'upside down face silly', 'ters yüz alaycı'],
  ['😉', 'winking face wink', 'göz kırpan yüz'],
  ['😊', 'smiling face smiling eyes blush happy', 'gülümseyen yüz utangaç mutlu'],
  ['😇', 'smiling face with halo angel innocent', 'melek masum'],
  ['🥰', 'smiling face with hearts love adore', 'aşık sevgi kalpli yüz'],
  ['😍', 'smiling face with heart eyes love', 'aşık kalp gözlü'],
  ['🤩', 'star struck amazed wow', 'yıldızlar gözünde şaşkın'],
  ['😘', 'face blowing a kiss kiss love', 'öpücük gönderen yüz'],
  ['😗', 'kissing face kiss', 'öpen yüz'],
  ['😚', 'kissing face closed eyes kiss', 'gözleri kapalı öpen yüz'],
  ['😋', 'face savoring food yum delicious', 'lezzetli yemek yiyen'],
  ['😛', 'face with tongue playful', 'dil çıkaran yüz'],
  ['😜', 'winking face with tongue playful joke', 'göz kırpıp dil çıkaran'],
  ['🤪', 'zany face crazy wild', 'çılgın deli'],
  ['🤗', 'hugging face hug', 'sarılan yüz kucaklama'],
  ['🤭', 'face with hand over mouth giggle oops', 'eliyle ağzını kapatan utanma'],
  ['🤫', 'shushing face quiet secret', 'sus işareti sır'],
  ['🤔', 'thinking face think hmm', 'düşünen yüz'],
  ['🤨', 'face with raised eyebrow skeptical', 'kaş kaldıran şüpheli'],
  ['😐', 'neutral face meh', 'nötr yüz'],
  ['😑', 'expressionless face blank', 'ifadesiz yüz'],
  ['😶', 'face without mouth speechless silent', 'ağzı olmayan suskun'],
  ['😏', 'smirking face smirk', 'kendini beğenmiş sırıtış'],
  ['😒', 'unamused face annoyed meh', 'memnuniyetsiz'],
  ['🙄', 'face with rolling eyes eye roll', 'göz deviren'],
  ['😬', 'grimacing face awkward', 'diş gıcırdatan rahatsız'],
  ['😮‍💨', 'face exhaling relief sigh phew', 'rahatlama nefes verme'],
  ['🤥', 'lying face lie pinocchio', 'yalancı yüz'],
  ['😌', 'relieved face calm', 'rahatlamış huzurlu'],
  ['😔', 'pensive face sad thoughtful', 'üzgün düşünceli'],
  ['😪', 'sleepy face tired', 'uykulu yorgun'],
  ['🤤', 'drooling face', 'salya akan'],
  ['😴', 'sleeping face zzz sleep tired', 'uyuyan yüz'],
  ['😷', 'face with medical mask sick', 'maskeli hasta yüz'],
  ['🤒', 'face with thermometer sick fever', 'hasta ateşli'],
  ['🤕', 'face with head bandage hurt', 'yaralı bandajlı'],
  ['🤢', 'nauseated face sick disgust', 'midesi bulanan'],
  ['🤮', 'face vomiting sick', 'kusan yüz'],
  ['🥵', 'hot face heat sweating', 'sıcak terlemiş'],
  ['🥶', 'cold face freezing', 'soğuk donmuş'],
  ['🥴', 'woozy face drunk dizzy', 'sersem sarhoş'],
  ['😵', 'dizzy face knocked out', 'başı dönmüş'],
  ['🤯', 'exploding head mind blown shock', 'şok patlayan kafa'],
  ['🤠', 'cowboy hat face', 'kovboy şapkalı'],
  ['🥳', 'partying face party celebration', 'parti kutlama'],
  ['🥺', 'pleading face puppy eyes please', 'yalvaran yüz rica'],
  ['😎', 'smiling face with sunglasses cool', 'güneş gözlüklü havalı'],
  ['🤓', 'nerd face glasses', 'inek gözlüklü'],
  ['🧐', 'face with monocle inspect', 'monokllü inceleyen'],
  ['😕', 'confused face puzzled', 'kafası karışık'],
  ['😟', 'worried face concern', 'endişeli'],
  ['🙁', 'slightly frowning face sad', 'hafif üzgün'],
  ['😮', 'face with open mouth surprised wow', 'şaşkın ağzı açık'],
  ['😯', 'hushed face surprised', 'suskun şaşkın'],
  ['😲', 'astonished face shocked', 'hayrete düşmüş'],
  ['😳', 'flushed face embarrassed blush', 'utanmış kızarmış'],
  ['🥺', 'pleading face beg', 'yalvaran'],
  ['😦', 'frowning face with open mouth', 'ağzı açık üzgün'],
  ['😨', 'fearful face scared', 'korkmuş'],
  ['😰', 'anxious face with sweat nervous', 'kaygılı terli'],
  ['😥', 'sad but relieved face', 'üzgün ama rahatlamış'],
  ['😢', 'crying face sad tear', 'ağlayan üzgün'],
  ['😭', 'loudly crying face sob sad', 'hıçkırarak ağlama'],
  ['😱', 'face screaming in fear horror', 'korkuyla çığlık'],
  ['😖', 'confounded face frustrated', 'bunalmış'],
  ['😣', 'persevering face struggle', 'zorlanan'],
  ['😞', 'disappointed face sad', 'hayal kırıklığı'],
  ['😓', 'downcast face with sweat', 'terli üzgün'],
  ['😩', 'weary face exhausted', 'bitkin yorgun'],
  ['😫', 'tired face exhausted', 'çok yorgun'],
  ['🥱', 'yawning face bored sleepy', 'esneyen sıkılmış'],
  ['😤', 'face with steam from nose triumph', 'burnundan soluyan öfkeli'],
  ['😡', 'pouting face angry mad', 'öfkeli kızgın'],
  ['😠', 'angry face mad', 'sinirli kızgın'],
  ['🤬', 'face with symbols on mouth swearing', 'küfreden öfkeli'],
  ['😈', 'smiling face with horns devil', 'şeytan gülüş'],
  ['👿', 'angry face with horns imp devil', 'öfkeli şeytan'],
  ['💀', 'skull dead', 'kuru kafa ölü'],
  ['💩', 'pile of poo poop', 'kaka'],
  ['🤡', 'clown face', 'palyaço'],
  ['👻', 'ghost boo', 'hayalet'],
  ['👽', 'alien ufo', 'uzaylı'],
  ['🤖', 'robot bot', 'robot'],
  ['😺', 'grinning cat happy', 'gülen kedi'],
  ['😹', 'cat with tears of joy laugh', 'gülmekten ağlayan kedi'],
  ['🙈', 'see no evil monkey', 'gözlerini kapatan maymun'],
  ['🙉', 'hear no evil monkey', 'kulaklarını kapatan maymun'],
  ['🙊', 'speak no evil monkey', 'ağzını kapatan maymun'],
  ['👋', 'waving hand wave hello hi bye', 'el sallama merhaba'],
  ['🤚', 'raised back of hand', 'kaldırılmış el'],
  ['✋', 'raised hand stop high five', 'duran el beşlik'],
  ['🖖', 'vulcan salute spock', 'vulkan selamı'],
  ['👌', 'ok hand okay perfect', 'tamam ok işareti'],
  ['🤌', 'pinched fingers italian', 'birleşik parmaklar'],
  ['🤏', 'pinching hand small', 'küçük tutam'],
  ['✌️', 'victory hand peace', 'zafer işareti barış'],
  ['🤞', 'crossed fingers luck', 'şans parmak'],
  ['🤟', 'love you gesture', 'seni seviyorum işareti'],
  ['🤘', 'sign of the horns rock', 'boynuz işareti rock'],
  ['🤙', 'call me hand shaka', 'beni ara işareti'],
  ['👈', 'backhand index pointing left', 'sola işaret'],
  ['👉', 'backhand index pointing right', 'sağa işaret'],
  ['👆', 'backhand index pointing up', 'yukarı işaret'],
  ['👇', 'backhand index pointing down', 'aşağı işaret'],
  ['☝️', 'index pointing up', 'yukarıyı gösteren parmak'],
  ['👍', 'thumbs up like approve ok', 'başparmak yukarı beğeni tamam'],
  ['👎', 'thumbs down dislike', 'başparmak aşağı beğenmedim'],
  ['✊', 'raised fist power', 'yumruk'],
  ['👊', 'oncoming fist punch bump', 'yumruk vuruş'],
  ['🤛', 'left facing fist', 'sola bakan yumruk'],
  ['🤜', 'right facing fist', 'sağa bakan yumruk'],
  ['👏', 'clapping hands applause bravo', 'alkış'],
  ['🙌', 'raising hands celebrate praise', 'iki elini kaldırma kutlama'],
  ['👐', 'open hands', 'açık eller'],
  ['🤲', 'palms up together dua', 'dua eden eller'],
  ['🤝', 'handshake deal agreement', 'el sıkışma anlaşma'],
  ['🙏', 'folded hands please thanks pray', 'rica teşekkür dua'],
  ['💪', 'flexed biceps strong muscle', 'pazı güçlü'],
  ['🦾', 'mechanical arm', 'mekanik kol'],
  ['✍️', 'writing hand', 'yazan el'],
  ['💅', 'nail polish manicure', 'oje'],
  ['👀', 'eyes look watching', 'gözler bakıyor'],
  ['👁️', 'eye', 'göz'],
  ['👅', 'tongue', 'dil'],
  ['👄', 'mouth lips', 'ağız dudak'],
  ['👶', 'baby', 'bebek'],
  ['🧑', 'person', 'kişi insan'],
  ['👨', 'man', 'adam erkek'],
  ['👩', 'woman', 'kadın'],
  ['🧔', 'bearded person', 'sakallı'],
  ['👮', 'police officer', 'polis'],
  ['🕵️', 'detective spy', 'dedektif'],
  ['💁', 'person tipping hand info', 'bilgi veren'],
  ['🙅', 'person gesturing no', 'hayır diyen'],
  ['🙆', 'person gesturing ok', 'tamam diyen'],
  ['🙋', 'person raising hand', 'el kaldıran'],
  ['🤦', 'person facepalming', 'yüzünü kapatan'],
  ['🤷', 'person shrugging', 'omuz silken'],
  ['🧑‍💻', 'technologist developer coder programmer', 'yazılımcı geliştirici'],
  ['👨‍💼', 'office worker businessman', 'ofis çalışanı iş adamı'],
  ['👩‍💼', 'office worker businesswoman', 'ofis çalışanı iş kadını'],
  ['🧑‍🔧', 'mechanic', 'tamirci'],
  ['🧑‍🍳', 'cook chef', 'aşçı'],
  ['🧑‍🏫', 'teacher', 'öğretmen'],
  ['🧑‍⚕️', 'health worker doctor', 'doktor sağlık'],
  ['🧑‍✈️', 'pilot', 'pilot'],
  ['🧑‍🚀', 'astronaut', 'astronot'],
  ['👥', 'busts in silhouette people group team', 'insanlar grup ekip'],
  ['🫂', 'people hugging', 'sarılan insanlar'],
];

const ANIMALS: Row[] = [
  ['🐶', 'dog face puppy', 'köpek yüzü'],
  ['🐱', 'cat face kitten', 'kedi yüzü'],
  ['🐭', 'mouse face', 'fare'],
  ['🐹', 'hamster', 'hamster'],
  ['🐰', 'rabbit face bunny', 'tavşan'],
  ['🦊', 'fox', 'tilki'],
  ['🐻', 'bear', 'ayı'],
  ['🐼', 'panda', 'panda'],
  ['🐨', 'koala', 'koala'],
  ['🐯', 'tiger face', 'kaplan'],
  ['🦁', 'lion', 'aslan'],
  ['🐮', 'cow face', 'inek'],
  ['🐷', 'pig face', 'domuz'],
  ['🐸', 'frog', 'kurbağa'],
  ['🐵', 'monkey face', 'maymun'],
  ['🐔', 'chicken', 'tavuk'],
  ['🐧', 'penguin', 'penguen'],
  ['🐦', 'bird', 'kuş'],
  ['🦅', 'eagle', 'kartal'],
  ['🦉', 'owl', 'baykuş'],
  ['🦇', 'bat', 'yarasa'],
  ['🐺', 'wolf', 'kurt'],
  ['🐗', 'boar', 'yaban domuzu'],
  ['🐴', 'horse face', 'at'],
  ['🦄', 'unicorn', 'tek boynuzlu at'],
  ['🐝', 'honeybee bee', 'arı'],
  ['🦋', 'butterfly', 'kelebek'],
  ['🐌', 'snail', 'salyangoz'],
  ['🐞', 'lady beetle ladybug', 'uğur böceği'],
  ['🐜', 'ant', 'karınca'],
  ['🕷️', 'spider', 'örümcek'],
  ['🐢', 'turtle', 'kaplumbağa'],
  ['🐍', 'snake', 'yılan'],
  ['🦎', 'lizard', 'kertenkele'],
  ['🐙', 'octopus', 'ahtapot'],
  ['🦑', 'squid', 'kalamar'],
  ['🦐', 'shrimp', 'karides'],
  ['🦀', 'crab', 'yengeç'],
  ['🐡', 'blowfish', 'balon balığı'],
  ['🐠', 'tropical fish', 'tropikal balık'],
  ['🐟', 'fish', 'balık'],
  ['🐬', 'dolphin', 'yunus'],
  ['🐳', 'spouting whale', 'balina'],
  ['🦈', 'shark', 'köpek balığı'],
  ['🐊', 'crocodile', 'timsah'],
  ['🐘', 'elephant', 'fil'],
  ['🦒', 'giraffe', 'zürafa'],
  ['🐪', 'camel', 'deve'],
  ['🐑', 'ewe sheep', 'koyun'],
  ['🐐', 'goat', 'keçi'],
  ['🦌', 'deer', 'geyik'],
  ['🐕', 'dog', 'köpek'],
  ['🐈', 'cat', 'kedi'],
  ['🐓', 'rooster', 'horoz'],
  ['🦃', 'turkey bird', 'hindi'],
  ['🌵', 'cactus', 'kaktüs'],
  ['🌲', 'evergreen tree', 'çam ağacı'],
  ['🌳', 'deciduous tree', 'ağaç'],
  ['🌴', 'palm tree', 'palmiye'],
  ['🌱', 'seedling plant', 'filiz fidan'],
  ['🌿', 'herb leaf', 'ot yaprak'],
  ['☘️', 'shamrock clover', 'yonca'],
  ['🍀', 'four leaf clover luck', 'dört yapraklı yonca şans'],
  ['🍁', 'maple leaf', 'akçaağaç yaprak yaprağı'],
  ['🍂', 'fallen leaf autumn', 'sonbahar yaprağı'],
  ['🍃', 'leaf fluttering in wind', 'rüzgarda yaprak'],
  ['🌹', 'rose flower', 'gül çiçek'],
  ['🌷', 'tulip', 'lale'],
  ['🌻', 'sunflower', 'ayçiçeği'],
  ['🌼', 'blossom flower', 'çiçek'],
  ['🌸', 'cherry blossom', 'kiraz çiçeği'],
  ['💐', 'bouquet flowers', 'buket çiçek'],
  ['🌎', 'globe earth world', 'dünya küre'],
  ['🌙', 'crescent moon night', 'ay gece'],
  ['⭐', 'star', 'yıldız'],
  ['🌟', 'glowing star', 'parlayan yıldız'],
  ['✨', 'sparkles magic', 'parıltılar sihir'],
  ['⚡', 'high voltage lightning', 'yıldırım elektrik'],
  ['🔥', 'fire flame hot lit', 'ateş alev'],
  ['🌈', 'rainbow', 'gökkuşağı'],
  ['☀️', 'sun sunny', 'güneş'],
  ['⛅', 'sun behind cloud', 'parçalı bulutlu'],
  ['☁️', 'cloud', 'bulut'],
  ['🌧️', 'rain cloud', 'yağmur'],
  ['⛈️', 'thunder cloud storm', 'fırtına'],
  ['❄️', 'snowflake snow cold', 'kar tanesi'],
  ['💧', 'droplet water', 'damla su'],
  ['🌊', 'water wave sea', 'dalga deniz'],
];

const FOOD: Row[] = [
  ['🍏', 'green apple', 'yeşil elma'],
  ['🍎', 'red apple', 'kırmızı elma'],
  ['🍐', 'pear', 'armut'],
  ['🍊', 'tangerine orange', 'mandalina portakal'],
  ['🍋', 'lemon', 'limon'],
  ['🍌', 'banana', 'muz'],
  ['🍉', 'watermelon', 'karpuz'],
  ['🍇', 'grapes', 'üzüm'],
  ['🍓', 'strawberry', 'çilek'],
  ['🫐', 'blueberries', 'yaban mersini'],
  ['🍒', 'cherries', 'kiraz'],
  ['🍑', 'peach', 'şeftali'],
  ['🥭', 'mango', 'mango'],
  ['🍍', 'pineapple', 'ananas'],
  ['🥥', 'coconut', 'hindistan cevizi'],
  ['🥝', 'kiwi fruit', 'kivi'],
  ['🍅', 'tomato', 'domates'],
  ['🥑', 'avocado', 'avokado'],
  ['🥦', 'broccoli', 'brokoli'],
  ['🥒', 'cucumber', 'salatalık'],
  ['🌶️', 'hot pepper spicy', 'acı biber'],
  ['🌽', 'corn', 'mısır'],
  ['🥕', 'carrot', 'havuç'],
  ['🧄', 'garlic', 'sarımsak'],
  ['🧅', 'onion', 'soğan'],
  ['🥔', 'potato', 'patates'],
  ['🍞', 'bread', 'ekmek'],
  ['🥐', 'croissant', 'kruvasan'],
  ['🥖', 'baguette bread', 'baget ekmek'],
  ['🥨', 'pretzel', 'pretzel'],
  ['🧀', 'cheese', 'peynir'],
  ['🍳', 'cooking fried egg', 'yumurta pişirme'],
  ['🥞', 'pancakes', 'pankek'],
  ['🧇', 'waffle', 'waffle'],
  ['🥓', 'bacon', 'pastırma'],
  ['🍔', 'hamburger burger', 'hamburger'],
  ['🍟', 'french fries', 'patates kızartması'],
  ['🍕', 'pizza', 'pizza'],
  ['🌭', 'hot dog', 'sosisli'],
  ['🥪', 'sandwich', 'sandviç'],
  ['🌮', 'taco', 'tako'],
  ['🌯', 'burrito', 'burrito'],
  ['🥙', 'stuffed flatbread doner kebab', 'dürüm döner'],
  ['🍜', 'steaming bowl noodles ramen', 'noodle çorba'],
  ['🍲', 'pot of food stew', 'tencere yemek'],
  ['🍛', 'curry rice', 'körili pilav'],
  ['🍣', 'sushi', 'suşi'],
  ['🍱', 'bento box', 'bento'],
  ['🥟', 'dumpling', 'mantı'],
  ['🍤', 'fried shrimp', 'kızarmış karides'],
  ['🍚', 'cooked rice', 'pilav'],
  ['🍥', 'fish cake', 'balık keki'],
  ['🍢', 'oden skewer', 'şiş'],
  ['🍡', 'dango', 'dango'],
  ['🍦', 'soft ice cream', 'dondurma'],
  ['🍩', 'doughnut donut', 'donut'],
  ['🍪', 'cookie biscuit', 'kurabiye bisküvi'],
  ['🎂', 'birthday cake', 'doğum günü pastası'],
  ['🍰', 'shortcake cake', 'pasta dilimi'],
  ['🧁', 'cupcake', 'kek'],
  ['🥧', 'pie', 'turta'],
  ['🍫', 'chocolate bar', 'çikolata'],
  ['🍬', 'candy sweet', 'şeker'],
  ['🍭', 'lollipop', 'lolipop'],
  ['🍮', 'custard pudding', 'puding'],
  ['🍯', 'honey pot', 'bal'],
  ['🍼', 'baby bottle milk', 'bebek biberonu'],
  ['🥛', 'glass of milk', 'süt'],
  ['☕', 'hot beverage coffee tea', 'sıcak içecek kahve çay'],
  ['🍵', 'teacup without handle tea', 'çay'],
  ['🧃', 'beverage box juice', 'meyve suyu kutusu'],
  ['🥤', 'cup with straw soda', 'gazoz bardak'],
  ['🧋', 'bubble tea', 'bubble tea'],
  ['🍺', 'beer mug', 'bira'],
  ['🍻', 'clinking beer mugs cheers', 'bira tokuşturma şerefe'],
  ['🥂', 'clinking glasses champagne cheers', 'kadeh kaldırma şerefe'],
  ['🍷', 'wine glass', 'şarap kadehi'],
  ['🥃', 'tumbler glass whisky', 'viski bardak bardağı'],
  ['🍸', 'cocktail glass', 'kokteyl'],
  ['🍾', 'bottle with popping cork champagne', 'şampanya'],
  ['🥗', 'green salad', 'salata'],
  ['🍽️', 'fork and knife plate restaurant', 'çatal bıçak tabak restoran'],
  ['🍴', 'fork and knife', 'çatal bıçak'],
];

const ACTIVITY: Row[] = [
  ['⚽', 'soccer ball football', 'futbol topu'],
  ['🏀', 'basketball', 'basketbol'],
  ['🏈', 'american football', 'amerikan futbolu'],
  ['⚾', 'baseball', 'beyzbol'],
  ['🎾', 'tennis', 'tenis'],
  ['🏐', 'volleyball', 'voleybol'],
  ['🏉', 'rugby football', 'ragbi'],
  ['🎱', 'pool 8 ball billiards', 'bilardo'],
  ['🏓', 'ping pong table tennis', 'masa tenisi'],
  ['🏸', 'badminton', 'badminton'],
  ['🥊', 'boxing glove', 'boks eldiveni'],
  ['🥋', 'martial arts uniform', 'dövüş sanatları'],
  ['⛳', 'flag in hole golf', 'golf'],
  ['⛸️', 'ice skate', 'buz pateni'],
  ['🎿', 'skis ski', 'kayak'],
  ['🛹', 'skateboard', 'kaykay'],
  ['🏂', 'snowboarder', 'snowboard'],
  ['🏋️', 'person lifting weights gym', 'halter spor salonu'],
  ['🚴', 'person biking bicycle', 'bisiklet'],
  ['🏃', 'person running run', 'koşan kişi'],
  ['🚶', 'person walking', 'yürüyen kişi'],
  ['🧘', 'person in lotus position yoga', 'yoga meditasyon'],
  ['🏊', 'person swimming', 'yüzme'],
  ['🎯', 'bullseye direct hit target', 'hedef tam isabet'],
  ['🎮', 'video game controller gaming', 'oyun kumandası'],
  ['🕹️', 'joystick game', 'joystick'],
  ['🎲', 'game die dice', 'zar'],
  ['🧩', 'puzzle piece', 'yapboz parçası'],
  ['♟️', 'chess pawn', 'satranç piyonu'],
  ['🎭', 'performing arts theater', 'tiyatro sahne'],
  ['🎨', 'artist palette art paint', 'resim paleti sanat'],
  ['🎬', 'clapper board movie film', 'film klaps'],
  ['🎤', 'microphone karaoke sing', 'mikrofon şarkı'],
  ['🎧', 'headphone music', 'kulaklık müzik'],
  ['🎼', 'musical score', 'nota'],
  ['🎹', 'musical keyboard piano', 'piyano klavye'],
  ['🥁', 'drum', 'davul'],
  ['🎸', 'guitar', 'gitar'],
  ['🎻', 'violin', 'keman'],
  ['🎺', 'trumpet', 'trompet'],
  ['🎷', 'saxophone', 'saksafon'],
  ['🪘', 'long drum', 'uzun davul'],
  ['🎉', 'party popper celebration tada', 'parti konfetisi kutlama'],
  ['🎊', 'confetti ball', 'konfeti topu'],
  ['🎈', 'balloon', 'balon'],
  ['🎁', 'wrapped gift present', 'hediye paketi'],
  ['🎀', 'ribbon', 'kurdele'],
  ['🏆', 'trophy win champion', 'kupa şampiyon'],
  ['🥇', 'first place medal gold', 'birinci altın madalya'],
  ['🥈', 'second place medal silver', 'ikinci gümüş'],
  ['🥉', 'third place medal bronze', 'üçüncü bronz'],
  ['🏅', 'sports medal', 'spor madalyası'],
  ['🎖️', 'military medal', 'askeri madalya'],
  ['🎓', 'graduation cap education', 'mezuniyet kepi'],
  ['📚', 'books study', 'kitaplar ders'],
  ['✏️', 'pencil write', 'kalem yazma'],
  ['📝', 'memo writing note', 'not yazma'],
  ['🎫', 'ticket', 'bilet'],
  ['🎪', 'circus tent', 'sirk çadırı'],
];

const TRAVEL: Row[] = [
  ['🚗', 'car automobile', 'araba otomobil'],
  ['🚕', 'taxi', 'taksi'],
  ['🚙', 'sport utility vehicle suv', 'suv araç'],
  ['🚌', 'bus', 'otobüs'],
  ['🚎', 'trolleybus', 'troleybüs'],
  ['🏎️', 'racing car formula', 'yarış arabası'],
  ['🚓', 'police car', 'polis arabası'],
  ['🚑', 'ambulance', 'ambulans'],
  ['🚒', 'fire engine truck', 'itfaiye'],
  ['🚚', 'delivery truck', 'kamyon'],
  ['🚛', 'articulated lorry truck', 'tır kamyon'],
  ['🚜', 'tractor', 'traktör'],
  ['🛵', 'motor scooter', 'scooter motosiklet'],
  ['🏍️', 'motorcycle', 'motosiklet'],
  ['🚲', 'bicycle bike', 'bisiklet'],
  ['🛴', 'kick scooter', 'scooter'],
  ['🚨', 'police car light siren alert', 'polis sireni uyarı'],
  ['🚔', 'oncoming police car', 'gelen polis arabası'],
  ['🚍', 'oncoming bus', 'gelen otobüs'],
  ['🚘', 'oncoming automobile', 'gelen araba'],
  ['🚖', 'oncoming taxi', 'gelen taksi'],
  ['🚡', 'aerial tramway cable car', 'teleferik'],
  ['🚂', 'locomotive train', 'lokomotif tren'],
  ['🚆', 'train', 'tren'],
  ['🚇', 'metro subway', 'metro'],
  ['🚊', 'tram', 'tramvay'],
  ['✈️', 'airplane flight travel', 'uçak uçuş'],
  ['🛫', 'airplane departure', 'uçak kalkış'],
  ['🛬', 'airplane arrival landing', 'uçak iniş'],
  ['🚁', 'helicopter', 'helikopter'],
  ['🚀', 'rocket launch space', 'roket fırlatma uzay'],
  ['🛸', 'flying saucer ufo', 'uçan daire'],
  ['🚢', 'ship boat', 'gemi'],
  ['⛵', 'sailboat', 'yelkenli'],
  ['🛥️', 'motor boat', 'motorbot'],
  ['⚓', 'anchor', 'çapa'],
  ['⛽', 'fuel pump gas', 'benzin pompası'],
  ['🚦', 'vertical traffic light', 'trafik lambası'],
  ['🗺️', 'world map', 'dünya haritası'],
  ['🧭', 'compass', 'pusula'],
  ['🏠', 'house home', 'ev'],
  ['🏢', 'office building', 'ofis binası'],
  ['🏥', 'hospital', 'hastane'],
  ['🏦', 'bank', 'banka'],
  ['🏨', 'hotel', 'otel'],
  ['🏪', 'convenience store', 'market dükkan'],
  ['🏭', 'factory', 'fabrika'],
  ['🏗️', 'building construction crane', 'inşaat vinç'],
  ['🗼', 'tokyo tower', 'kule'],
  ['🗽', 'statue of liberty', 'özgürlük heykeli'],
  ['🏰', 'castle', 'kale'],
  ['⛰️', 'mountain', 'dağ'],
  ['🏖️', 'beach with umbrella', 'plaj şemsiye'],
  ['🏝️', 'desert island', 'ada'],
  ['🏕️', 'camping tent', 'kamp çadır'],
  ['🌃', 'night with stars city', 'gece şehir'],
  ['🌆', 'cityscape at dusk', 'şehir manzarası'],
  ['🌉', 'bridge at night', 'gece köprü'],
  ['🗿', 'moai statue', 'moai heykeli'],
  ['💺', 'seat', 'koltuk'],
  ['🛎️', 'bellhop bell hotel service', 'resepsiyon zili otel'],
  ['🎡', 'ferris wheel', 'dönme dolap'],
];

const OBJECTS: Row[] = [
  ['⌚', 'watch time', 'saat kol saati'],
  ['📱', 'mobile phone smartphone iphone', 'cep telefonu'],
  ['💻', 'laptop computer', 'dizüstü bilgisayar'],
  ['⌨️', 'keyboard', 'klavye'],
  ['🖥️', 'desktop computer monitor', 'masaüstü bilgisayar'],
  ['🖨️', 'printer', 'yazıcı'],
  ['🖱️', 'computer mouse', 'fare'],
  ['💽', 'computer disk', 'disk'],
  ['💾', 'floppy disk save', 'disket kaydet'],
  ['💿', 'optical disk cd', 'cd'],
  ['📀', 'dvd', 'dvd'],
  ['📷', 'camera photo', 'fotoğraf makinesi'],
  ['📸', 'camera with flash', 'flaşlı fotoğraf'],
  ['📹', 'video camera', 'video kamera'],
  ['🎥', 'movie camera film', 'film kamerası'],
  ['📺', 'television tv', 'televizyon'],
  ['📻', 'radio', 'radyo'],
  ['🔋', 'battery', 'pil batarya'],
  ['🔌', 'electric plug', 'fiş priz'],
  ['💡', 'light bulb idea', 'ampul fikir'],
  ['🔦', 'flashlight', 'el feneri'],
  ['🕯️', 'candle', 'mum'],
  ['🧯', 'fire extinguisher', 'yangın söndürücü'],
  ['🛢️', 'oil drum', 'varil'],
  ['💸', 'money with wings', 'uçan para'],
  ['💵', 'dollar banknote money', 'dolar banknot'],
  ['💶', 'euro banknote money', 'euro banknot'],
  ['💷', 'pound banknote money', 'sterlin'],
  ['💰', 'money bag', 'para çuval çuvalı'],
  ['💳', 'credit card payment', 'kredi kartı ödeme'],
  ['🧾', 'receipt invoice', 'fatura fiş'],
  ['💎', 'gem stone diamond', 'elmas mücevher'],
  ['⚖️', 'balance scale justice', 'terazi adalet'],
  ['🔧', 'wrench tool', 'ingiliz anahtarı'],
  ['🔨', 'hammer tool', 'çekiç'],
  ['⚒️', 'hammer and pick tools', 'çekiç ve kazma'],
  ['🛠️', 'hammer and wrench tools', 'aletler'],
  ['⚙️', 'gear settings', 'dişli ayar'],
  ['🧰', 'toolbox', 'takım çantası'],
  ['🔩', 'nut and bolt', 'somun vida'],
  ['🧲', 'magnet', 'mıknatıs'],
  ['🔫', 'water pistol gun', 'tabanca'],
  ['💣', 'bomb', 'bomba'],
  ['🔪', 'kitchen knife', 'bıçak'],
  ['🗡️', 'dagger', 'hançer'],
  ['🛡️', 'shield', 'kalkan'],
  ['🔑', 'key', 'anahtar'],
  ['🗝️', 'old key', 'eski anahtar'],
  ['🔒', 'locked lock', 'kilitli'],
  ['🔓', 'unlocked lock', 'kilit açık'],
  ['🔐', 'locked with key secure', 'güvenli kilit'],
  ['📦', 'package box shipping', 'koli paket'],
  ['📫', 'closed mailbox with raised flag', 'posta kutusu'],
  ['📮', 'postbox', 'posta kutusu'],
  ['✉️', 'envelope email mail', 'zarf e-posta'],
  ['📧', 'e-mail', 'e-posta'],
  ['📨', 'incoming envelope', 'gelen zarf'],
  ['📩', 'envelope with arrow', 'oklu zarf'],
  ['📄', 'page facing up document', 'belge sayfa'],
  ['📃', 'page with curl', 'kıvrık sayfa'],
  ['📑', 'bookmark tabs', 'yer imi sekmeler'],
  ['📊', 'bar chart', 'çubuk grafik'],
  ['📈', 'chart increasing growth', 'artış grafiği'],
  ['📉', 'chart decreasing', 'düşüş grafiği'],
  ['📋', 'clipboard', 'pano'],
  ['📌', 'pushpin', 'raptiye'],
  ['📍', 'round pushpin location', 'konum iğnesi'],
  ['📎', 'paperclip attachment', 'ataç ek'],
  ['🖇️', 'linked paperclips', 'bağlı ataç'],
  ['📏', 'straight ruler', 'cetvel'],
  ['📐', 'triangular ruler', 'gönye'],
  ['✂️', 'scissors cut', 'makas kes'],
  ['🗃️', 'card file box archive', 'kart kutusu arşiv'],
  ['🗄️', 'file cabinet', 'dosya dolap dolabı'],
  ['🗑️', 'wastebasket trash delete', 'çöp kutusu sil'],
  ['📁', 'file folder', 'klasör'],
  ['📂', 'open file folder', 'açık klasör'],
  ['📅', 'calendar date', 'takvim tarih'],
  ['📆', 'tear-off calendar', 'takvim yaprağı'],
  ['🗓️', 'spiral calendar', 'spiral takvim'],
  ['📇', 'card index', 'kart dizini'],
  ['📖', 'open book read', 'açık kitap oku'],
  ['📕', 'closed book red', 'kapalı kitap'],
  ['📰', 'newspaper news', 'gazete haber'],
  ['🔖', 'bookmark', 'yer imi'],
  ['🏷️', 'label tag', 'etiket'],
  ['🧷', 'safety pin', 'çengelli iğne'],
  ['🪙', 'coin', 'madeni para'],
  ['⏰', 'alarm clock time', 'alarm saati'],
  ['⏳', 'hourglass not done', 'kum saati'],
  ['⌛', 'hourglass done', 'kum saati bitti'],
  ['🕐', 'one o clock', 'saat bir'],
  ['📡', 'satellite antenna signal', 'uydu anten sinyal'],
];

const SYMBOLS: Row[] = [
  ['❤️', 'red heart love', 'kırmızı kalp aşk sevgi'],
  ['🧡', 'orange heart', 'turuncu kalp'],
  ['💛', 'yellow heart', 'sarı kalp'],
  ['💚', 'green heart', 'yeşil kalp'],
  ['💙', 'blue heart', 'mavi kalp'],
  ['💜', 'purple heart', 'mor kalp'],
  ['🖤', 'black heart', 'siyah kalp'],
  ['🤍', 'white heart', 'beyaz kalp'],
  ['🤎', 'brown heart', 'kahverengi kalp'],
  ['💔', 'broken heart', 'kırık kalp'],
  ['❤️‍🔥', 'heart on fire', 'alevli kalp'],
  ['💕', 'two hearts', 'iki kalp'],
  ['💞', 'revolving hearts', 'dönen kalpler'],
  ['💓', 'beating heart', 'atan kalp'],
  ['💗', 'growing heart', 'büyüyen kalp'],
  ['💖', 'sparkling heart', 'parıldayan kalp'],
  ['💘', 'heart with arrow cupid', 'oklu kalp'],
  ['💝', 'heart with ribbon', 'kurdeleli kalp'],
  ['💟', 'heart decoration', 'kalp süsü'],
  ['❣️', 'heart exclamation', 'kalp ünlem'],
  ['💯', 'hundred points perfect score', 'yüz puan mükemmel'],
  ['✅', 'check mark button done yes', 'onay işareti tamam evet'],
  ['☑️', 'check box with check', 'işaretli kutu'],
  ['✔️', 'check mark', 'tik işareti'],
  ['❌', 'cross mark no wrong', 'çarpı hayır yanlış'],
  ['❎', 'cross mark button', 'çarpı butonu'],
  ['❗', 'exclamation mark', 'ünlem'],
  ['❕', 'white exclamation mark', 'beyaz ünlem'],
  ['❓', 'question mark', 'soru işareti'],
  ['❔', 'white question mark', 'beyaz soru işareti'],
  ['‼️', 'double exclamation mark', 'çift ünlem'],
  ['⁉️', 'exclamation question mark', 'ünlem soru'],
  ['⚠️', 'warning', 'uyarı dikkat'],
  ['🚫', 'prohibited no forbidden', 'yasak hayır'],
  ['⛔', 'no entry', 'giriş yok'],
  ['📵', 'no mobile phones', 'telefon yasak'],
  ['🔞', 'no one under eighteen', '18 yaş altı yasak'],
  ['♻️', 'recycling symbol', 'geri dönüşüm'],
  ['🔰', 'japanese symbol for beginner', 'yeni başlayan'],
  ['🆗', 'ok button', 'tamam butonu'],
  ['🆕', 'new button', 'yeni'],
  ['🆓', 'free button', 'ücretsiz'],
  ['🆒', 'cool button', 'havalı'],
  ['🆙', 'up button', 'yukarı'],
  ['🔝', 'top arrow', 'en üst'],
  ['🔄', 'counterclockwise arrows refresh', 'yenile döngü'],
  ['🔁', 'repeat button', 'tekrarla'],
  ['🔀', 'shuffle tracks button', 'karıştır'],
  ['▶️', 'play button', 'oynat'],
  ['⏸️', 'pause button', 'duraklat'],
  ['⏹️', 'stop button', 'durdur'],
  ['⏭️', 'next track button', 'sonraki'],
  ['⏮️', 'last track button', 'önceki'],
  ['🔊', 'speaker high volume', 'hoparlör ses'],
  ['🔇', 'muted speaker', 'ses kapalı'],
  ['🔔', 'bell notification', 'zil bildirim'],
  ['🔕', 'bell with slash muted', 'sessiz zil'],
  ['📢', 'loudspeaker announcement', 'hoparlör duyuru'],
  ['📣', 'megaphone announce', 'megafon duyuru'],
  ['💬', 'speech balloon comment', 'konuşma balonu yorum'],
  ['💭', 'thought balloon', 'düşünce balonu'],
  ['🗯️', 'right anger bubble', 'öfke balonu'],
  ['👋🏻', 'waving hand light skin', 'el sallama açık ten'],
  ['🕐', 'clock', 'saat'],
  ['♾️', 'infinity', 'sonsuzluk'],
  ['➕', 'plus sign add', 'artı ekle'],
  ['➖', 'minus sign', 'eksi'],
  ['➗', 'divide sign', 'bölme'],
  ['✖️', 'multiply sign', 'çarpma'],
  ['🟰', 'heavy equals sign', 'eşittir'],
  ['💲', 'dollar sign', 'dolar işareti'],
  ['💱', 'currency exchange', 'döviz kuru'],
  ['™️', 'trade mark', 'ticari marka'],
  ['©️', 'copyright', 'telif hakkı'],
  ['®️', 'registered', 'tescil'],
  ['🔟', 'keycap ten', 'on rakamı'],
  ['🔢', 'input numbers', 'sayılar'],
  ['🔤', 'input latin letters', 'harfler'],
  ['🔠', 'input latin uppercase', 'büyük harf'],
  ['🔡', 'input latin lowercase', 'küçük harf'],
  ['⬆️', 'up arrow', 'yukarı ok'],
  ['⬇️', 'down arrow', 'aşağı ok'],
  ['⬅️', 'left arrow', 'sol ok'],
  ['➡️', 'right arrow', 'sağ ok'],
  ['🔃', 'clockwise vertical arrows', 'saat yönü oklar'],
  ['🆘', 'sos button help', 'yardım'],
  ['🛑', 'stop sign', 'dur işareti'],
  ['🧿', 'nazar amulet evil eye', 'nazar boncuk boncuğu'],
  ['☪️', 'star and crescent', 'ay yıldız'],
  ['✝️', 'latin cross', 'haç'],
  ['🕉️', 'om', 'om'],
  ['☮️', 'peace symbol', 'barış sembolü'],
  ['⚛️', 'atom symbol', 'atom'],
  ['🉑', 'japanese acceptable button', 'kabul'],
  ['🆚', 'versus button', 'karşı'],
  ['🔱', 'trident emblem', 'üç dişli'],
  ['⭕', 'hollow red circle', 'boş kırmızı daire'],
  ['✅', 'green check', 'yeşil tik'],
];

// Turkish inflected forms are spelled with BOTH the stem and the inflected
// word: "bayrak" is what people type, but the natural Turkish is "bayrağı"
// (k -> ğ), and a substring search for "bayrak" cannot see "bayrağı". The same
// trap applies to other nouns here (yaprak/yaprağı, dolap/dolabı, ...).
const FLAGS: Row[] = [
  ['🇹🇷', 'turkey flag turkish', 'türkiye türk bayrak bayrağı'],
  ['🇺🇸', 'united states flag usa america american', 'amerika amerikan birleşik devletleri bayrak'],
  ['🇬🇧', 'united kingdom flag britain england british', 'ingiltere ingiliz birleşik krallık bayrak'],
  ['🇩🇪', 'germany flag german', 'almanya alman bayrak'],
  ['🇫🇷', 'france flag french', 'fransa fransız bayrak'],
  ['🇳🇱', 'netherlands flag dutch holland', 'hollanda flemenk bayrak'],
  ['🇮🇹', 'italy flag italian', 'italya italyan bayrak'],
  ['🇪🇸', 'spain flag spanish', 'ispanya ispanyol bayrak'],
  ['🇷🇺', 'russia flag russian', 'rusya rus bayrak'],
  ['🇦🇿', 'azerbaijan flag azeri', 'azerbaycan azeri bayrak'],
  ['🇸🇦', 'saudi arabia flag', 'suudi arabistan bayrak'],
  ['🇦🇪', 'united arab emirates flag uae dubai', 'bae dubai birleşik arap emirlikleri bayrak'],
  ['🇨🇳', 'china flag chinese', 'çin çinli bayrak'],
  ['🇯🇵', 'japan flag japanese', 'japonya japon bayrak'],
  ['🇮🇳', 'india flag indian', 'hindistan hint bayrak'],
  ['🇧🇷', 'brazil flag brazilian', 'brezilya brezilyalı bayrak'],
  ['🇨🇦', 'canada flag canadian', 'kanada kanadalı bayrak'],
  ['🇦🇺', 'australia flag', 'avustralya bayrak'],
  ['🏁', 'chequered flag finish race', 'damalı bayrak yarış bitiş'],
  ['🚩', 'triangular flag', 'üçgen bayrak'],
  ['🏳️', 'white flag', 'beyaz bayrak'],
  ['🏴', 'black flag', 'siyah bayrak'],
  ['🏳️‍🌈', 'rainbow flag pride', 'gökkuşağı bayrak onur'],
];

/** Category order and tab icons match WhatsApp Web / iOS. */
export const EMOJI_CATEGORIES: { id: EmojiCategoryId; icon: string; labelKey: string }[] = [
  { id: 'recent', icon: '🕘', labelKey: 'whatsapp.emojiRecentlyUsed' },
  { id: 'smileys', icon: '😀', labelKey: 'whatsapp.emojiCategorySmileys' },
  { id: 'animals', icon: '🐻', labelKey: 'whatsapp.emojiCategoryAnimals' },
  { id: 'food', icon: '🍔', labelKey: 'whatsapp.emojiCategoryFood' },
  { id: 'activity', icon: '⚽', labelKey: 'whatsapp.emojiCategoryActivity' },
  { id: 'travel', icon: '✈️', labelKey: 'whatsapp.emojiCategoryTravel' },
  { id: 'objects', icon: '💡', labelKey: 'whatsapp.emojiCategoryObjects' },
  { id: 'symbols', icon: '❤️', labelKey: 'whatsapp.emojiCategorySymbols' },
  { id: 'flags', icon: '🏁', labelKey: 'whatsapp.emojiCategoryFlags' },
];

function toEntries(rows: Row[]): EmojiEntry[] {
  const seen = new Set<string>();
  const out: EmojiEntry[] = [];
  for (const [char, keywords, tr] of rows) {
    // The data is hand-written; a duplicated character would render the same
    // emoji twice in the grid, so it is collapsed rather than trusted.
    if (seen.has(char)) continue;
    seen.add(char);
    out.push({ char, keywords, tr });
  }
  return out;
}

export const EMOJI_BY_CATEGORY: Record<Exclude<EmojiCategoryId, 'recent'>, EmojiEntry[]> = {
  smileys: toEntries(SMILEYS),
  animals: toEntries(ANIMALS),
  food: toEntries(FOOD),
  activity: toEntries(ACTIVITY),
  travel: toEntries(TRAVEL),
  objects: toEntries(OBJECTS),
  symbols: toEntries(SYMBOLS),
  flags: toEntries(FLAGS),
};

export const ALL_EMOJIS: EmojiEntry[] = Object.values(EMOJI_BY_CATEGORY).flat();

/**
 * Search across every category, English AND Turkish.
 *
 * Ranked so the obvious result wins:
 *   0 — the whole keyword field is the query ("pizza" -> 🍕)
 *   1 — a whole word is the query ("ok" -> 👌, not 🍳)
 *   2 — a word starts with the query ("thank" -> 🙏)
 *   3 — the query appears anywhere ("avocado" -> 🥑)
 * Without the ranking, results fall back to dataset order and "ok" surfaces
 * 🍳 (cooking) before 👌 because food precedes symbols in the catalogue.
 * Ties keep catalogue order, which is the same order the grid shows.
 */
export function searchEmojis(query: string, limit = 60): EmojiEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { entry: EmojiEntry; rank: number }[] = [];
  for (const entry of ALL_EMOJIS) {
    let best: number | null = null;
    for (const field of [entry.keywords, entry.tr]) {
      if (!field) continue;
      let rank: number | null = null;
      if (field === q) {
        rank = 0;
      } else if (field.split(' ').includes(q)) {
        rank = 1;
      } else if (field.split(' ').some((w) => w.startsWith(q))) {
        rank = 2;
      } else if (field.includes(q)) {
        rank = 3;
      }
      if (rank !== null && (best === null || rank < best)) best = rank;
    }
    if (best !== null) scored.push({ entry, rank: best });
  }
  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, limit).map((s) => s.entry);
}

export const EMOJI_RECENTS_KEY = 'tezlify_emoji_recent';
export const EMOJI_RECENTS_MAX = 24;

/** Minimal storage contract, so this is testable without a DOM. */
export interface EmojiStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function readRaw(storage?: EmojiStorage): string {
  const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
  if (!store) return '';
  try {
    return store.getItem(EMOJI_RECENTS_KEY) ?? '';
  } catch {
    // Private-mode storage can throw on read; a missing recents row is fine.
    return '';
  }
}

export function loadRecentEmojis(storage?: EmojiStorage): string[] {
  const raw = readRaw(storage);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string').slice(0, EMOJI_RECENTS_MAX);
  } catch {
    return [];
  }
}

/** Most recent first, no duplicates, capped. Returns the new list. */
export function pushRecentEmoji(char: string, storage?: EmojiStorage): string[] {
  const next = [char, ...loadRecentEmojis(storage).filter((c) => c !== char)]
    .slice(0, EMOJI_RECENTS_MAX);
  const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
  try {
    store?.setItem(EMOJI_RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Storage full/blocked: the picker still works, recents just do not persist.
  }
  return next;
}

/**
 * Insert a picked emoji at the caret, the way WhatsApp Web does.
 *
 * Appending to the end would put the character in the wrong place whenever the
 * user moved the caret back into the middle of a draft.
 */
export function insertAtCaret(
  current: string,
  inserted: string,
  selectionStart: number | null,
  selectionEnd: number | null,
): { text: string; caret: number } {
  const len = current.length;
  const start = typeof selectionStart === 'number' ? Math.max(0, Math.min(selectionStart, len)) : len;
  const end = typeof selectionEnd === 'number' ? Math.max(start, Math.min(selectionEnd, len)) : start;
  return {
    text: current.slice(0, start) + inserted + current.slice(end),
    caret: start + inserted.length,
  };
}
