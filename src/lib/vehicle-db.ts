import { isExcludedPassengerMake } from "@/lib/vehicle-scope";
// MEKANIX — Iranian vehicle database (comprehensive)
// Includes ALL Iranian assemblers (مونتاژ) + importers with their full model
// catalogs and rich per-model metadata (years, segment, engine, fuel, notes).
//
// IMPORTANT: For Iranian companies, `make` is the Persian name (primary display),
// `makeEn` is the English transliteration (for search/sort). Foreign brands keep
// English `make` with their country label.

export type VehicleSegment =
  | "sedan"
  | "hatchback"
  | "liftback"
  | "suv"
  | "crossover"
  | "pickup"
  | "van"
  | "minibus"
  | "coupe"
  | "ev"
  | "commercial";

export type VehicleFuel = "petrol" | "diesel" | "hybrid" | "ev" | "cng" | "lpg";

export interface VehicleModel {
  name: string;
  years?: string;       // "2001-2013" / "2020-present" / "2006-present"
  segment?: VehicleSegment;
  engine?: string;       // "1.6L 16v TU5"
  fuel?: VehicleFuel;
  notes?: string;        // montage base, Iranian-specific notes
}

export interface VehicleMake {
  make: string;            // PRIMARY: Persian for Iranian companies, English for foreign
  makeEn?: string;         // English name (for Iranian companies; used in search/sort)
  country: string;         // "ایران" / "فرانسه" / ...
  assembler?: string;      // Parent group / assembler name (Persian) if different
  founded?: number;
  description?: string;
  models: string[];        // flat list (backward compatible)
  catalog?: VehicleModel[];  // rich per-model data
}

// ──────────── PASSENGER VEHICLES (خودروی سواری) ────────────
// Iranian assemblers / manufacturers FIRST, then importers,
// then major foreign brands commonly seen on Iranian roads.

export const PASSENGER_MAKES: VehicleMake[] = [
  // ═══════════ Iranian Manufacturers / Assemblers ═══════════
  {
    make: "ایران خودرو",
    makeEn: "Iran Khodro (IKCO)",
    country: "ایران",
    assembler: "گروه ایران خودرو",
    founded: 1962,
    description: "بزرگ‌ترین خودروساز ایران. تولیدکننده پژو، سمند، دنا، رانا، تارا و محصولات مونتاژی.",
    models: [
      "پژو 206 (تیپ ۵)", "پژو 206 SD", "پژو 207i", "پژو 207i SD",
      "پژو 405", "پژو 405 SLX", "پژو پارس", "پژو پارس ELX",
      "پژو SD", "پژو ROA", "سمند", "سمند LX", "سمند ELX",
      "سمند سورن", "سمند سورن EX", "سمند تاکسی",
      "دنا", "دنا پلاس", "دنا پلاس توربو",
      "rana", "rana plus", "آریسان ریشی",
      "تارا", "KJ (کاین ایران خودرو)", "هایما S7 (ایران خودرو)", "دامی (وانت)",
    ],
    catalog: [
      { name: "پژو 206 (تیپ ۵)", years: "2001-2013", segment: "hatchback", engine: "1.4L / 1.6L TU5", fuel: "petrol" },
      { name: "پژو 206 SD", years: "2006-present", segment: "sedan", engine: "1.6L TU5", fuel: "petrol", notes: "نسخه سدان ۲۰۶ مونتاژ ایران خودرو" },
      { name: "پژو 207i", years: "2010-2018", segment: "hatchback", engine: "1.6L TU5", fuel: "petrol" },
      { name: "پژو 207i SD", years: "2011-2018", segment: "sedan", engine: "1.6L TU5", fuel: "petrol" },
      { name: "پژو 405", years: "1990-2022", segment: "sedan", engine: "1.8L XU7", fuel: "petrol", notes: "طولانی‌ترین تولید پژو در ایران" },
      { name: "پژو 405 SLX", years: "1990-2020", segment: "sedan", engine: "1.8L XU7", fuel: "petrol" },
      { name: "پژو پارس", years: "2006-2020", segment: "sedan", engine: "1.8L XU7", fuel: "petrol", notes: "فیس‌لیفت ۴۰۵" },
      { name: "پژو پارس ELX", years: "2008-2020", segment: "sedan", engine: "1.8L XU7", fuel: "petrol" },
      { name: "پژو SD", years: "2008-2012", segment: "sedan", engine: "1.8L XU7", fuel: "petrol" },
      { name: "پژو ROA", years: "2008-2015", segment: "sedan", engine: "1.6L TU5", fuel: "petrol" },
      { name: "سمند", years: "2000-2020", segment: "sedan", engine: "1.8L XU7 / 1.6L TU5", fuel: "petrol", notes: "خودرو ملی ایران" },
      { name: "سمند LX", years: "2003-2018", segment: "sedan", engine: "1.8L XU7", fuel: "petrol" },
      { name: "سمند ELX", years: "2007-2018", segment: "sedan", engine: "1.8L XU7", fuel: "petrol" },
      { name: "سمند سورن", years: "2007-2020", segment: "sedan", engine: "1.8L XU7 / 1.7L EF7", fuel: "petrol" },
      { name: "سمند سورن EX", years: "2014-2020", segment: "sedan", engine: "1.7L EF7 turbo", fuel: "petrol" },
      { name: "سمند تاکسی", years: "2003-2020", segment: "sedan", engine: "1.6L TU5 / CNG", fuel: "cng" },
      { name: "دنا", years: "2011-present", segment: "sedan", engine: "1.7L EF7", fuel: "petrol", notes: "جانشین سمند" },
      { name: "دنا پلاس", years: "2018-present", segment: "sedan", engine: "1.7L EF7", fuel: "petrol" },
      { name: "دنا پلاس توربو", years: "2021-present", segment: "sedan", engine: "1.5L turbo", fuel: "petrol" },
      { name: "rana", years: "2012-2020", segment: "sedan", engine: "1.4L TU3", fuel: "petrol" },
      { name: "rana plus", years: "2016-2020", segment: "sedan", engine: "1.4L TU3", fuel: "petrol" },
      { name: "آریسان ریشی", years: "2018-present", segment: "hatchback", engine: "1.5L", fuel: "petrol", notes: "نسخه فیس‌لیفت ۲۰۷" },
      { name: "تارا", years: "2021-present", segment: "sedan", engine: "1.6L turbo", fuel: "petrol", notes: "بر پایه پژو ۳۰۱ / سیتروئن C-Elysée" },
      { name: "KJ (کاین ایران خودرو)", years: "2023-present", segment: "suv", engine: "2.0L turbo", fuel: "petrol", notes: "مونتاژ پورشه کاین" },
      { name: "هایما S7 (ایران خودرو)", years: "2014-2019", segment: "suv", engine: "2.0L", fuel: "petrol" },
      { name: "دامی (وانت)", years: "2022-present", segment: "pickup", engine: "1.5L", fuel: "petrol" },
    ],
  },
  {
    make: "سایپا",
    makeEn: "Saipa",
    country: "ایران",
    assembler: "گروه سایپا",
    founded: 1966,
    description: "دومین خودروساز ایران. تولیدکننده پراید، تیبا، شاهین و کویک.",
    models: [
      "پراید 131 (سدان)", "پراید 132 (هاچ‌بک)", "پراید صبا", "پراید 141 (لیفت‌بک)",
      "صبا ۵ در", "کویک", "کویک R", "کویک اتوماتیک", "تیبا", "تیبا ۲",
      "شاهین", "شاهین پلاس", "شاهین ۱.۵ لیتر", "شاهین ۱.۶ لیتر", "شاهین اتوماتیک",
      "سراتو", "اسپکترا", "ریو", "سیلو (مفهومی)", "سایما ۱۱۱ (مفهومی)",
      "پراید 131 دوگانه‌سوز CNG", "سایپا ۱۵۱ (زیبا)",
    ],
    catalog: [
      { name: "پراید 131 (سدان)", years: "1993-2021", segment: "sedan", engine: "1.3L Mazda B3", fuel: "petrol", notes: "بر پایه کیا پراید" },
      { name: "پراید 132 (هاچ‌بک)", years: "1993-2021", segment: "hatchback", engine: "1.3L B3", fuel: "petrol" },
      { name: "پراید صبا", years: "2001-2021", segment: "liftback", engine: "1.3L B3", fuel: "petrol" },
      { name: "پراید 141 (لیفت‌بک)", years: "2003-2021", segment: "liftback", engine: "1.3L B3", fuel: "petrol" },
      { name: "صبا ۵ در", years: "2001-2021", segment: "hatchback", engine: "1.3L B3", fuel: "petrol" },
      { name: "کویک", years: "2014-present", segment: "liftback", engine: "1.5L", fuel: "petrol", notes: "بر پایه پراید با طراحی جدید" },
      { name: "کویک R", years: "2017-present", segment: "liftback", engine: "1.5L", fuel: "petrol" },
      { name: "کویک اتوماتیک", years: "2020-present", segment: "liftback", engine: "1.5L", fuel: "petrol" },
      { name: "تیبا", years: "2009-2020", segment: "hatchback", engine: "1.5L", fuel: "petrol", notes: "پلتفرم مستقل سایپا" },
      { name: "تیبا ۲", years: "2015-2020", segment: "hatchback", engine: "1.5L", fuel: "petrol" },
      { name: "شاهین", years: "2020-present", segment: "sedan", engine: "1.5L", fuel: "petrol", notes: "بر پایه کیا ریو" },
      { name: "شاهین پلاس", years: "2022-present", segment: "sedan", engine: "1.6L turbo", fuel: "petrol" },
      { name: "شاهین ۱.۵ لیتر", years: "2020-present", segment: "sedan", engine: "1.5L", fuel: "petrol" },
      { name: "شاهین ۱.۶ لیتر", years: "2021-present", segment: "sedan", engine: "1.6L", fuel: "petrol" },
      { name: "شاهین اتوماتیک", years: "2022-present", segment: "sedan", engine: "1.6L", fuel: "petrol" },
      { name: "سراتو", years: "2018-present", segment: "sedan", engine: "1.6L", fuel: "petrol", notes: "مونتاژ کیا سراتو" },
      { name: "اسپکترا", years: "2004-2012", segment: "hatchback", engine: "1.6L", fuel: "petrol", notes: "مونتاژ کیا اسپکترا" },
      { name: "ریو", years: "2015-2019", segment: "sedan", engine: "1.6L", fuel: "petrol", notes: "مونتاژ کیا ریو" },
      { name: "پراید 131 دوگانه‌سوز CNG", years: "2008-2021", segment: "sedan", engine: "1.3L B3 / CNG", fuel: "cng" },
      { name: "سایپا ۱۵۱ (زیبا)", years: "2020-present", segment: "liftback", engine: "1.5L", fuel: "petrol" },
    ],
  },
  {
    make: "پارس خودرو",
    makeEn: "Pars Khodro",
    country: "ایران",
    assembler: "گروه سایپا (پارس خودرو)",
    founded: 1967,
    description: "مونتاژکننده رنو، نیسان و تندار ۹۰ (پلتفرم لوگان).",
    models: [
      "رنو L90 (تندار ۹۰)", "تندار ۹۰ سدان", "تندار ۹۰ پلاس", "تندار ۹۰ LX",
      "رنو ساندرو", "رنو ساندرو استپ‌وی",
      "نیسان پاترول", "نیسان پاترول سفاری", "نیسان ماکسیما", "نیسان تینا", "نیسان سانی",
      "پارس خودرو ۱۳۱ (پراید)", "رنو مگان (مونتاژ)",
    ],
    catalog: [
      { name: "رنو L90 (تندار ۹۰)", years: "2008-2020", segment: "sedan", engine: "1.6L K7M", fuel: "petrol", notes: "بر پایه رنو لوگان" },
      { name: "تندار ۹۰ سدان", years: "2008-2020", segment: "sedan", engine: "1.6L K7M", fuel: "petrol" },
      { name: "تندار ۹۰ پلاس", years: "2014-2020", segment: "sedan", engine: "1.6L K7M", fuel: "petrol" },
      { name: "تندار ۹۰ LX", years: "2008-2015", segment: "sedan", engine: "1.6L K7M", fuel: "petrol" },
      { name: "رنو ساندرو", years: "2012-2018", segment: "hatchback", engine: "1.6L K7M", fuel: "petrol", notes: "مونتاژ رنو ساندرو" },
      { name: "رنو ساندرو استپ‌وی", years: "2014-2018", segment: "crossover", engine: "1.6L K7M", fuel: "petrol" },
      { name: "نیسان پاترول", years: "1998-2010", segment: "suv", engine: "4.5L / 4.8L", fuel: "petrol", notes: "مونتاژ نیسان پاترول" },
      { name: "نیسان پاترول سفاری", years: "2001-2010", segment: "suv", engine: "4.8L", fuel: "petrol" },
      { name: "نیسان ماکسیما", years: "2000-2010", segment: "sedan", engine: "2.0L / 3.0L V6", fuel: "petrol" },
      { name: "نیسان تینا", years: "2008-2015", segment: "sedan", engine: "2.5L V6", fuel: "petrol" },
      { name: "نیسان سانی", years: "2005-2012", segment: "sedan", engine: "1.5L", fuel: "petrol" },
      { name: "پارس خودرو ۱۳۱ (پراید)", years: "1996-2001", segment: "sedan", engine: "1.3L B3", fuel: "petrol", notes: "تولید پراید پیش از انتقال به سایپا" },
      { name: "رنو مگان (مونتاژ)", years: "2004-2008", segment: "sedan", engine: "1.6L", fuel: "petrol" },
    ],
  },
  {
    make: "بهمن موتور",
    makeEn: "Bahman Motor",
    country: "ایران",
    assembler: "گروه بهمن",
    founded: 1959,
    description: "مونتاژ مازدا، میتسوبیشی و ایسوزو.",
    models: [
      "مازدا ۳۲۳", "مازدا ۳", "مازدا ۶", "مازدا دمیو", "مازدا B2000",
      "میتسوبیشی پاجرو", "میتسوبیشی L200", "میتسوبیشی گالانت",
      "ایسوزو D-Max", "فوتون ویو", "فوتون اومان",
    ],
    catalog: [
      { name: "مازدا ۳۲۳", years: "1992-2005", segment: "sedan", engine: "1.3L / 1.5L", fuel: "petrol", notes: "مونتاژ مازدا ۳۲۳" },
      { name: "مازدا ۳", years: "2004-2018", segment: "sedan", engine: "1.6L / 2.0L", fuel: "petrol" },
      { name: "مازدا ۶", years: "2008-2019", segment: "sedan", engine: "2.0L / 2.5L", fuel: "petrol" },
      { name: "مازدا دمیو", years: "2003-2012", segment: "hatchback", engine: "1.3L / 1.5L", fuel: "petrol" },
      { name: "مازدا B2000", years: "1989-2005", segment: "pickup", engine: "2.0L", fuel: "petrol" },
      { name: "میتسوبیشی پاجرو", years: "1998-2018", segment: "suv", engine: "3.0L / 3.8L V6", fuel: "petrol" },
      { name: "میتسوبیشی L200", years: "2005-2018", segment: "pickup", engine: "2.5L / 2.4L", fuel: "diesel" },
      { name: "میتسوبیشی گالانت", years: "2003-2012", segment: "sedan", engine: "2.4L", fuel: "petrol" },
      { name: "ایسوزو D-Max", years: "2008-2018", segment: "pickup", engine: "2.5L diesel", fuel: "diesel" },
      { name: "فوتون ویو", years: "2010-2018", segment: "van", engine: "2.8L diesel", fuel: "diesel" },
      { name: "فوتون اومان", years: "2012-present", segment: "commercial", engine: "10L diesel", fuel: "diesel" },
    ],
  },
  {
    make: "کرمان موتور",
    makeEn: "Kerman Motor (KMC)",
    country: "ایران",
    assembler: "گروه کرمان",
    founded: 1996,
    description: "مونتاژ هیوندای، چری و جی‌ای‌سی. (کرمان موتور / کرمان خودرو)",
    models: [
      "هیوندای النترا", "هیوندای آکسنت", "هیوندای توسان", "هیوندای i10", "هیوندای i20",
      "هیوندای i30", "چری آریزو ۵", "چری آریزو ۶", "چری آریزو ۸",
      "چری تیگو ۵", "چری تیگو ۷", "چری تیگو ۸",
      "JAC S3", "JAC S4", "JAC S5", "JAC J7", "JAC X7 پلاس",
      "FAW بستون B70", "FAW اُلی",
    ],
    catalog: [
      { name: "هیوندای النترا", years: "2010-2019", segment: "sedan", engine: "1.6L / 2.0L", fuel: "petrol", notes: "مونتاژ هیوندای النترا" },
      { name: "هیوندای آکسنت", years: "2008-2018", segment: "sedan", engine: "1.4L / 1.6L", fuel: "petrol" },
      { name: "هیوندای توسان", years: "2012-2018", segment: "suv", engine: "2.0L", fuel: "petrol" },
      { name: "هیوندای i10", years: "2012-2018", segment: "hatchback", engine: "1.0L / 1.2L", fuel: "petrol" },
      { name: "هیوندای i20", years: "2012-2018", segment: "hatchback", engine: "1.4L / 1.6L", fuel: "petrol" },
      { name: "هیوندای i30", years: "2014-2018", segment: "hatchback", engine: "1.6L", fuel: "petrol" },
      { name: "چری آریزو ۵", years: "2018-present", segment: "sedan", engine: "1.5L", fuel: "petrol" },
      { name: "چری آریزو ۶", years: "2020-present", segment: "sedan", engine: "1.5L turbo", fuel: "petrol" },
      { name: "چری آریزو ۸", years: "2022-present", segment: "sedan", engine: "1.6L turbo", fuel: "petrol" },
      { name: "چری تیگو ۵", years: "2017-present", segment: "suv", engine: "1.5L turbo", fuel: "petrol" },
      { name: "چری تیگو ۷", years: "2019-present", segment: "suv", engine: "1.5L / 1.6L turbo", fuel: "petrol" },
      { name: "چری تیگو ۸", years: "2020-present", segment: "suv", engine: "1.6L turbo", fuel: "petrol" },
      { name: "JAC S3", years: "2017-present", segment: "suv", engine: "1.5L / 1.6L", fuel: "petrol" },
      { name: "JAC S4", years: "2019-present", segment: "crossover", engine: "1.5L turbo", fuel: "petrol" },
      { name: "JAC S5", years: "2016-present", segment: "suv", engine: "2.0L turbo", fuel: "petrol" },
      { name: "JAC J7", years: "2020-present", segment: "hatchback", engine: "1.5L turbo", fuel: "petrol" },
      { name: "JAC X7 پلاس", years: "2022-present", segment: "suv", engine: "1.5L turbo", fuel: "petrol" },
      { name: "FAW بستون B70", years: "2019-present", segment: "sedan", engine: "1.5L turbo", fuel: "petrol" },
      { name: "FAW اُلی", years: "2021-present", segment: "sedan", engine: "1.4L", fuel: "petrol" },
    ],
  },
  {
    make: "آریان خودرو",
    makeEn: "Arian Khodro",
    country: "ایران",
    assembler: "آریان خودرو",
    founded: 2000,
    description: "مونتاژ آریا و شهاب خودرو (پلتفرم ال۹۰).",
    models: ["آریا", "آریا ۲", "شهاب خودرو وانت ۴ در", "شهاب خودرو وانت ۲ در"],
    catalog: [
      { name: "آریا", years: "2014-present", segment: "sedan", engine: "1.6L K7M", fuel: "petrol", notes: "بر پایه پلتفرم تندار ۹۰" },
      { name: "آریا ۲", years: "2018-present", segment: "sedan", engine: "1.6L K7M", fuel: "petrol" },
      { name: "شهاب خودرو وانت ۴ در", years: "2014-present", segment: "pickup", engine: "1.6L K7M", fuel: "petrol" },
      { name: "شهاب خودرو وانت ۲ در", years: "2014-present", segment: "pickup", engine: "1.6L K7M", fuel: "petrol" },
    ],
  },
  {
    make: "مدیران خودرو",
    makeEn: "Modiran Khodro",
    country: "ایران",
    assembler: "مدیران خودرو",
    founded: 2003,
    description: "مونتاژ و واردکننده محصولات مازدا.",
    models: ["مازدا ۳ (مونتاژ)", "مازدا ۶ (مونتاژ)", "مازدا CX-5 (واردات)", "مازدا CX-30 (واردات)"],
    catalog: [
      { name: "مازدا ۳ (مونتاژ)", years: "2008-2018", segment: "sedan", engine: "1.6L / 2.0L", fuel: "petrol", notes: "مونتاژ مدیران خودرو" },
      { name: "مازدا ۶ (مونتاژ)", years: "2010-2019", segment: "sedan", engine: "2.0L / 2.5L", fuel: "petrol" },
      { name: "مازدا CX-5 (واردات)", years: "2018-present", segment: "suv", engine: "2.0L / 2.5L", fuel: "petrol" },
      { name: "مازدا CX-30 (واردات)", years: "2021-present", segment: "crossover", engine: "2.0L", fuel: "petrol" },
    ],
  },
  {
    make: "دیبا موتور",
    makeEn: "Diba Motor",
    country: "ایران",
    assembler: "دیبا موتور",
    founded: 2017,
    description: "تولید خودروی ملی کوچک (دیبا M1/M2) با موتور پژو.",
    models: ["دیبا M1", "دیبا M2", "دیبا T8"],
    catalog: [
      { name: "دیبا M1", years: "2019-present", segment: "sedan", engine: "1.6L EC5 (پژو)", fuel: "petrol", notes: "خودروی ملی کوچک" },
      { name: "دیبا M2", years: "2021-present", segment: "sedan", engine: "1.6L EC5", fuel: "petrol" },
      { name: "دیبا T8", years: "2020-present", segment: "hatchback", engine: "1.6L EC5", fuel: "petrol" },
    ],
  },
  {
    make: "کوروش موتور",
    makeEn: "Kourosh Motor (K1)",
    country: "ایران",
    assembler: "کوروش موتور (K1)",
    founded: 2018,
    description: "تولید‌کننده خودروی الکتریکی ایرانی (K1 EV، Olia EV).",
    models: ["K1 EV", "Olia EV"],
    catalog: [
      { name: "K1 EV", years: "2021-present", segment: "ev", engine: "100 kW electric", fuel: "ev", notes: "اولین EV تولیدی ایران" },
      { name: "Olia EV", years: "2023-present", segment: "ev", engine: "120 kW electric", fuel: "ev" },
    ],
  },
  {
    make: "آپکس موتور",
    makeEn: "Apex Motor",
    country: "ایران",
    assembler: "آپکس موتور",
    founded: 2019,
    description: "تولید خودروی الکتریکی (نرا) به‌صورت مشارکتی با ایران خودرو.",
    models: ["نرا EV", "سورن EV (مشارکت ایران خودرو)"],
    catalog: [
      { name: "نرا EV", years: "2022-present", segment: "ev", engine: "80 kW electric", fuel: "ev" },
      { name: "سورن EV (مشارکت ایران خودرو)", years: "2023-present", segment: "ev", engine: "100 kW electric", fuel: "ev", notes: "نسخه الکتریکی سمند سورن" },
    ],
  },
  {
    make: "فردا موتور",
    makeEn: "Farda Motor",
    country: "ایران",
    assembler: "فردا موتور",
    founded: 2003,
    description: "واردکننده و مونتاژکننده سیتروئن و پژو در ایران.",
    models: [
      "سیتروئن C3", "سیتروئن C4", "سیتروئن C5", "سیتروئن C-Elysée", "سیتروئن برلینگو",
      "پژو ۲۰۰۸", "پژو ۲۰۸ (واردات)",
    ],
    catalog: [
      { name: "سیتروئن C3", years: "2010-2018", segment: "hatchback", engine: "1.4L / 1.6L", fuel: "petrol", notes: "واردات فردا موتور" },
      { name: "سیتروئن C4", years: "2012-2018", segment: "hatchback", engine: "1.6L turbo", fuel: "petrol" },
      { name: "سیتروئن C5", years: "2014-2018", segment: "sedan", engine: "1.6L / 2.0L turbo", fuel: "petrol" },
      { name: "سیتروئن C-Elysée", years: "2014-2018", segment: "sedan", engine: "1.6L", fuel: "petrol" },
      { name: "سیتروئن برلینگو", years: "2014-2018", segment: "van", engine: "1.6L", fuel: "petrol" },
      { name: "پژو ۲۰۰۸", years: "2016-2018", segment: "crossover", engine: "1.6L", fuel: "petrol" },
      { name: "پژو ۲۰۸ (واردات)", years: "2016-2018", segment: "hatchback", engine: "1.2L / 1.6L", fuel: "petrol" },
    ],
  },
  {
    make: "مراتب موتور",
    makeEn: "Morattab Motor",
    country: "ایران",
    assembler: "مراتب موتور",
    founded: 1990,
    description: "مونتاژ مراتب K2 (شبیه سوزوکی ویتارا).",
    models: ["مراتب K2"],
    catalog: [
      { name: "مراتب K2", years: "2005-2015", segment: "suv", engine: "1.6L / 2.0L", fuel: "petrol", notes: "کپی سوزوکی ویتارا" },
    ],
  },
  {
    make: "رخش خودرو دیزل",
    makeEn: "Rakhsh Khodro Diesel (RKD)",
    country: "ایران",
    assembler: "رخش خودرو دیزل",
    founded: 1996,
    description: "تولید خودروهای صنعتی و وانت‌های کوچک.",
    models: ["RKD وانت", "RKD مینی‌تراک"],
    catalog: [
      { name: "RKD وانت", years: "2005-present", segment: "pickup", engine: "2.0L", fuel: "petrol" },
      { name: "RKD مینی‌تراک", years: "2008-present", segment: "commercial", engine: "1.6L", fuel: "petrol" },
    ],
  },
  {
    make: "هپکو",
    makeEn: "Hepco",
    country: "ایران",
    assembler: "هپکو (صنایع سنگین آراک)",
    founded: 1974,
    description: "تولید ماشین‌آلات سنگین و کامیون‌های سبک (نیرو N711).",
    models: ["هپکو نیرو N711", "هپکو مینی‌تراک"],
    catalog: [
      { name: "هپکو نیرو N711", years: "2015-present", segment: "commercial", engine: "2.0L diesel", fuel: "diesel", notes: "مینی‌کامیون بومی هپکو" },
      { name: "هپکو مینی‌تراک", years: "2018-present", segment: "commercial", engine: "2.0L diesel", fuel: "diesel" },
    ],
  },
  {
    make: "ستاره ایران",
    makeEn: "Setareh Iran",
    country: "ایران",
    assembler: "ستاره ایران",
    founded: 2001,
    description: "مونتاژ دانگ‌فنگ و جی‌ای‌سی در ایران.",
    models: ["دانگ‌فنگ S30", "دانگ‌فنگ H30 کراس", "دانگ‌فنگ AX7", "JAC J5 (مونتاژ)", "JAC ریفاین"],
    catalog: [
      { name: "دانگ‌فنگ S30", years: "2012-2018", segment: "sedan", engine: "1.6L", fuel: "petrol", notes: "مونتاژ دانگ‌فنگ S30" },
      { name: "دانگ‌فنگ H30 کراس", years: "2014-2018", segment: "crossover", engine: "1.6L", fuel: "petrol" },
      { name: "دانگ‌فنگ AX7", years: "2018-2022", segment: "suv", engine: "2.0L", fuel: "petrol" },
      { name: "JAC J5 (مونتاژ)", years: "2010-2016", segment: "sedan", engine: "1.6L / 2.0L", fuel: "petrol" },
      { name: "JAC ریفاین", years: "2014-2018", segment: "van", engine: "2.0L", fuel: "petrol" },
    ],
  },
  {
    make: "دیاپارس (سازه گستر ساحل)",
    makeEn: "Sazeh Gostar Sahand (Diapars)",
    country: "ایران",
    assembler: "سازه گستر ساحل (دیاپارس)",
    founded: 1998,
    description: "مونتاژ مینی‌تراک‌ها و وانت‌های دانگ‌فنگ.",
    models: ["دیاپارس دانگ‌فنگ مینی‌وانت", "دیاپارس کاپیتن", "دیاپارس ریچ"],
    catalog: [
      { name: "دیاپارس دانگ‌فنگ مینی‌وانت", years: "2010-present", segment: "pickup", engine: "1.5L", fuel: "petrol", notes: "مینی‌وانت دانگ‌فنگ" },
      { name: "دیاپارس کاپیتن", years: "2018-present", segment: "pickup", engine: "2.4L", fuel: "petrol" },
      { name: "دیاپارس ریچ", years: "2020-present", segment: "pickup", engine: "2.4L", fuel: "petrol" },
    ],
  },
  {
    make: "رای خودرو",
    makeEn: "Ray Khodro",
    country: "ایران",
    assembler: "رای خودرو",
    founded: 2008,
    description: "واردکننده MG و سایر برندهای چینی.",
    models: ["MG3", "MG5", "MG6", "MG ZS", "MG HS"],
    catalog: [
      { name: "MG3", years: "2018-present", segment: "hatchback", engine: "1.5L", fuel: "petrol", notes: "واردات توسط رای خودرو" },
      { name: "MG5", years: "2020-present", segment: "sedan", engine: "1.5L turbo", fuel: "petrol" },
      { name: "MG6", years: "2019-present", segment: "sedan", engine: "1.5L turbo", fuel: "petrol" },
      { name: "MG ZS", years: "2019-present", segment: "suv", engine: "1.5L", fuel: "petrol" },
      { name: "MG HS", years: "2020-present", segment: "suv", engine: "1.5L turbo", fuel: "petrol" },
    ],
  },
  {
    make: "ساحل موتور",
    makeEn: "Sahand Motor",
    country: "ایران",
    assembler: "ساحل موتور",
    founded: 2010,
    description: "واردکننده برندهای چینی مختلف.",
    models: ["چانگان آلسوین", "چانگان ایادو", "چانگان CS35 پلاس", "چانگان CS55", "چانگان CS75 پلاس"],
    catalog: [
      { name: "چانگان آلسوین", years: "2020-present", segment: "sedan", engine: "1.4L / 1.5L", fuel: "petrol" },
      { name: "چانگان ایادو", years: "2019-present", segment: "sedan", engine: "1.6L", fuel: "petrol" },
      { name: "چانگان CS35 پلاس", years: "2020-present", segment: "suv", engine: "1.4L turbo", fuel: "petrol" },
      { name: "چانگان CS55", years: "2020-present", segment: "suv", engine: "1.5L turbo", fuel: "petrol" },
      { name: "چانگان CS75 پلاس", years: "2021-present", segment: "suv", engine: "2.0L turbo", fuel: "petrol" },
    ],
  },
  {
    make: "بناگ نچین ساحل",
    makeEn: "Bonag Nechin Sahand",
    country: "ایران",
    assembler: "بناگ نچین ساحل",
    founded: 2014,
    description: "مونتاژ کامیون‌های سبک دانگ‌فنگ و JAC.",
    models: ["بناگ کاپیتن", "بناگ ریچ", "بناگ T1"],
    catalog: [
      { name: "بناگ کاپیتن", years: "2018-present", segment: "pickup", engine: "2.4L", fuel: "petrol" },
      { name: "بناگ ریچ", years: "2020-present", segment: "pickup", engine: "2.4L", fuel: "petrol" },
      { name: "بناگ T1", years: "2022-present", segment: "pickup", engine: "2.0L turbo", fuel: "petrol" },
    ],
  },
  {
    make: "زاگرس خودرو",
    makeEn: "Zagross Khodro",
    country: "ایران",
    assembler: "زاگرس خودرو",
    founded: 1995,
    description: "مونتاژ مرسدس بنز و کامیون‌های سبک.",
    models: ["مرسدس بنز کلاس C (مونتاژ)", "مرسدس بنز کلاس E (مونتاژ)"],
    catalog: [
      { name: "مرسدس بنز کلاس C (مونتاژ)", years: "2001-2008", segment: "sedan", engine: "1.8L / 2.0L Kompressor", fuel: "petrol", notes: "مونتاژ زاگرس خودرو" },
      { name: "مرسدس بنز کلاس E (مونتاژ)", years: "2001-2008", segment: "sedan", engine: "2.6L / 3.2L", fuel: "petrol" },
    ],
  },
  {
    make: "مونتاژ خودرو تبریز",
    makeEn: "Montaj Khodro-e-Tabriz (MTA)",
    country: "ایران",
    assembler: "مونتاژ خودرو تبریز",
    founded: 1996,
    description: "مونتاژ گسترده‌ی محصولات (پژو ۴۰۵، پراید، رانا).",
    models: ["پژو 405 (مونتاژ)", "پراید 131 (مونتاژ)", "rana (مونتاژ)"],
    catalog: [
      { name: "پژو 405 (مونتاژ)", years: "2003-2020", segment: "sedan", engine: "1.8L XU7", fuel: "petrol" },
      { name: "پراید 131 (مونتاژ)", years: "2003-2021", segment: "sedan", engine: "1.3L B3", fuel: "petrol" },
      { name: "rana (مونتاژ)", years: "2015-2020", segment: "sedan", engine: "1.4L TU3", fuel: "petrol" },
    ],
  },
  {
    make: "دنیای خودرو",
    makeEn: "Donya Khodro",
    country: "ایران",
    assembler: "دنیای خودرو",
    founded: 2011,
    description: "واردکننده برندهای اروپایی و آسیایی مختلف.",
    models: ["بی‌ام‌و سری ۳ (واردات)", "بی‌ام‌و سری ۵ (واردات)", "آudi A4 (واردات)", "هیوندای سانتافه (واردات)"],
    catalog: [
      { name: "بی‌ام‌و سری ۳ (واردات)", years: "2015-present", segment: "sedan", engine: "2.0L turbo", fuel: "petrol" },
      { name: "بی‌ام‌و سری ۵ (واردات)", years: "2016-present", segment: "sedan", engine: "2.0L / 3.0L turbo", fuel: "petrol" },
      { name: "آudi A4 (واردات)", years: "2015-present", segment: "sedan", engine: "2.0L turbo", fuel: "petrol" },
      { name: "هیوندای سانتافه (واردات)", years: "2017-present", segment: "suv", engine: "2.4L", fuel: "petrol" },
    ],
  },
  {
    make: "پالاز موتور",
    makeEn: "Palaz Motor",
    country: "ایران",
    assembler: "پالاز موتور",
    founded: 2009,
    description: "واردکننده خودروهای لوکس و تجاری.",
    models: ["پورشه ماکان (واردات)", "پورشه کاین (واردات)", "لکسوس RX (واردات)"],
    catalog: [
      { name: "پورشه ماکان (واردات)", years: "2016-present", segment: "suv", engine: "2.0L turbo", fuel: "petrol" },
      { name: "پورشه کاین (واردات)", years: "2016-present", segment: "suv", engine: "3.0L turbo", fuel: "petrol" },
      { name: "لکسوس RX (واردات)", years: "2017-present", segment: "suv", engine: "3.5L V6", fuel: "petrol" },
    ],
  },
  {
    make: "گسترش خودرو",
    makeEn: "Gostaresh Khodro",
    country: "ایران",
    assembler: "گسترش خودرو",
    founded: 2012,
    description: "واردکننده برندهای چینی و کره‌ای.",
    models: ["کیا اسپورتیج (واردات)", "هیوندای توسان (واردات)", "بی‌ام‌و X5 (واردات)"],
    catalog: [
      { name: "کیا اسپورتیج (واردات)", years: "2016-present", segment: "suv", engine: "2.0L / 2.4L", fuel: "petrol" },
      { name: "هیوندای توسان (واردات)", years: "2017-present", segment: "suv", engine: "2.0L / 2.4L", fuel: "petrol" },
      { name: "بی‌ام‌و X5 (واردات)", years: "2018-present", segment: "suv", engine: "3.0L turbo", fuel: "petrol" },
    ],
  },
  {
    make: "نوین خودرو",
    makeEn: "Novin Khodro",
    country: "ایران",
    assembler: "نوین خودرو",
    founded: 2010,
    description: "واردکننده خودروهای ژاپنی و اروپایی.",
    models: ["تویوتا کرولا (واردات)", "تویوتا کمری (واردات)", "هوندا سیویک (واردات)"],
    catalog: [
      { name: "تویوتا کرولا (واردات)", years: "2015-present", segment: "sedan", engine: "1.6L / 1.8L", fuel: "petrol" },
      { name: "تویوتا کمری (واردات)", years: "2016-present", segment: "sedan", engine: "2.0L / 2.5L", fuel: "petrol" },
      { name: "هوندا سیویک (واردات)", years: "2017-present", segment: "sedan", engine: "1.5L / 2.0L", fuel: "petrol" },
    ],
  },
  {
    make: "آرمان خودرو",
    makeEn: "Arman Khodro",
    country: "ایران",
    assembler: "آرمان خودرو",
    founded: 2013,
    description: "واردکننده خودروهای لوکس اروپایی.",
    models: ["مرسدس بنز کلاس S (واردات)", "مرسدس بنز GLE (واردات)", "آudi Q7 (واردات)"],
    catalog: [
      { name: "مرسدس بنز کلاس S (واردات)", years: "2017-present", segment: "sedan", engine: "3.0L / 4.0L turbo", fuel: "petrol" },
      { name: "مرسدس بنز GLE (واردات)", years: "2017-present", segment: "suv", engine: "3.0L turbo", fuel: "petrol" },
      { name: "آudi Q7 (واردات)", years: "2017-present", segment: "suv", engine: "3.0L turbo", fuel: "petrol" },
    ],
  },
  {
    make: "سپهر خودرو",
    makeEn: "Sepehr Khodro",
    country: "ایران",
    assembler: "سپهر خودرو",
    founded: 2014,
    description: "واردکننده خودروهای چینی (هاوال، گریت وال).",
    models: ["هاوال جولیون", "هاوال H6", "هاوال H9", "گریت وال وال‌کانی"],
    catalog: [
      { name: "هاوال جولیون", years: "2020-present", segment: "crossover", engine: "1.5L turbo", fuel: "petrol" },
      { name: "هاوال H6", years: "2020-present", segment: "suv", engine: "1.5L / 2.0L turbo", fuel: "petrol" },
      { name: "هاوال H9", years: "2021-present", segment: "suv", engine: "2.0L turbo", fuel: "petrol" },
      { name: "گریت وال وال‌کانی", years: "2018-present", segment: "suv", engine: "2.0L turbo", fuel: "petrol" },
    ],
  },
  {
    make: "آسیا موتور",
    makeEn: "Asia Motor",
    country: "ایران",
    assembler: "آسیا موتور",
    founded: 2008,
    description: "واردکننده خودروهای کره‌ای و چینی.",
    models: ["کیا سورنتو (واردات)", "کیا کارنیوال (واردات)", "هیوندای پالیسید (واردات)"],
    catalog: [
      { name: "کیا سورنتو (واردات)", years: "2017-present", segment: "suv", engine: "2.4L / 3.5L V6", fuel: "petrol" },
      { name: "کیا کارنیوال (واردات)", years: "2018-present", segment: "van", engine: "3.3L V6", fuel: "petrol" },
      { name: "هیوندای پالیسید (واردات)", years: "2020-present", segment: "suv", engine: "3.8L V6", fuel: "petrol" },
    ],
  },

  // ═══════════ Chinese Brands (common imports/montage in Iran) ═══════════
  { make: "Chery", country: "چین", models: ["Tiggo 5", "Tiggo 7", "Tiggo 8", "Arrizo 5", "Arrizo 6", "Arrizo 8", "E3", "E5"] },
  { make: "Haval", country: "چین", models: ["Jolion", "Jolion Pro", "H6", "H6 GT", "H9"] },
  { make: "Geely", country: "چین", models: ["Emgrand 7", "Emgrand X7", "Coolray", "Tugella", "Atlas"] },
  { make: "BYD", country: "چین", models: ["F3", "Song Plus", "Han EV", "Atto 3", "Dolphin"] },
  { make: "Changan", country: "چین", models: ["CS35 Plus", "CS55", "CS75 Plus", "CS95", "Eado", "Alsvin"] },
  { make: "JAC", country: "چین", models: ["S3", "S4", "S5", "J7", "X7 Plus", "e-J7 (EV)"] },
  { make: "Dongfeng", country: "چین", models: ["SX5", "EX1", "T5 EVO", "Captain", "Rich"] },
  { make: "Bestune", country: "چین", models: ["T77", "T99", "B70", "NAT"] },

  // ═══════════ European ═══════════
  { make: "Peugeot", country: "فرانسه", models: ["206", "207", "208", "301", "308", "405", "406", "407", "508", "2008", "3008", "5008"] },
  { make: "Renault", country: "فرانسه", models: ["Clio", "Megane", "Fluence", "Talisman", "Sandero", "Duster", "Captur", "Koleos", "L90 (Tondar)"] },
  { make: "Citroën", country: "فرانسه", models: ["C3", "C4", "C5", "C-Elysée", "Berlingo"] },
  { make: "Fiat", country: "ایتالیا", models: ["500", "Punto", "Tipo", "Panda", "Doblo"] },
  { make: "Volkswagen", country: "آلمان", models: ["Golf", "Polo", "Passat", "Tiguan", "Touareg", "Arteon", "Golf GTI"] },
  { make: "BMW", country: "آلمان", models: ["118i", "320i", "330i", "520i", "530i", "730Li", "X1", "X3", "X5", "X6"] },
  { make: "Mercedes-Benz", country: "آلمان", models: ["A180", "A200", "C180", "C200", "C300", "E200", "E300", "S500", "GLA200", "GLC300", "GLE350", "GLS450"] },
  { make: "Audi", country: "آلمان", models: ["A3", "A4", "A6", "A8", "Q3", "Q5", "Q7", "Q8"] },
  { make: "Porsche", country: "آلمان", models: ["911", "Cayenne", "Macan", "Panamera", "Taycan"] },
  { make: "Volvo", country: "سوئد", models: ["S60", "S90", "XC40", "XC60", "XC90"] },
  { make: "Skoda", country: "چک", models: ["Octavia", "Fabia", "Superb", "Kodiaq", "Karoq"] },

  // ═══════════ Asian ═══════════
  { make: "Toyota", country: "ژاپن", models: ["Corolla", "Camry", "Yaris", "Corolla Cross", "RAV4", "Highlander", "Land Cruiser", "Prado", "Hilux", "Prius", "C-HR"] },
  { make: "Honda", country: "ژاپن", models: ["Civic", "Accord", "City", "CR-V", "HR-V", "Pilot"] },
  { make: "Hyundai", country: "کره جنوبی", models: ["Elantra", "Sonata", "Accent", "i10", "i20", "i30", "Tucson", "Santa Fe", "Creta", "Casper", "Palisade"] },
  { make: "Kia", country: "کره جنوبی", models: ["Cerato", "Optima", "Picanto", "Rio", "Sportage", "Sorento", "Carnival", "Seltos", "Stonic"] },
  { make: "Nissan", country: "ژاپن", models: ["Maxima", "Teana", "Altima", "Patrol", "Juke", "Qashqai", "X-Trail", "Pathfinder"] },
  { make: "Mazda", country: "ژاپن", models: ["3", "6", "CX-3", "CX-5", "CX-9", "323", "B2000"] },
  { make: "Mitsubishi", country: "ژاپن", models: ["Lancer", "Pajero", "Outlander", "ASX", "L200"] },
  { make: "Subaru", country: "ژاپن", models: ["Impreza", "Forester", "Outback", "XV", "Legacy"] },
  { make: "Lexus", country: "ژاپن", models: ["IS200", "ES300", "RX350", "LX570", "GX460", "NX300"] },

  // ═══════════ American ═══════════
  { make: "Chevrolet", country: "آمریکا", models: ["Cruze", "Malibu", "Tahoe", "Equinox", "Spark", "Camaro"] },
  { make: "Ford", country: "آمریکا", models: ["Fiesta", "Focus", "Fusion", "Escape", "Explorer", "Mustang", "Ranger"] },

  // ═══════════ British ═══════════
  { make: "Land Rover", country: "انگلیس", models: ["Range Rover", "Range Rover Sport", "Discovery", "Defender", "Evoque", "Velar"] },
  { make: "Jaguar", country: "انگلیس", models: ["XE", "XF", "F-Pace", "E-Pace", "I-Pace"] },
];

// ─── Heavy Machinery & Commercial (ماشین‌آلات سنگین) ───
export const HEAVY_MAKES: VehicleMake[] = [
  // Trucks
  { make: "Volvo Trucks", country: "سوئد", models: ["FH16", "FH", "FM", "FMX", "FE", "FL"] },
  { make: "Scania", country: "سوئد", models: ["R450", "R500", "S500", "S650", "P360", "G410", "P280"] },
  { make: "Mercedes-Benz Trucks", country: "آلمان", models: ["Actros", "Arocs", "Atego", "Antos", "Econic"] },
  { make: "MAN", country: "آلمان", models: ["TGX", "TGS", "TGL", "TGM"] },
  { make: "DAF", country: "هلند", models: ["XF", "XG", "CF", "LF"] },
  { make: "Iveco", country: "ایتالیا", models: ["S-Way", "X-Way", "T-Way", "Daily", "Stralis"] },
  { make: "Renault Trucks", country: "فرانسه", models: ["T High", "T", "K", "C", "D"] },
  {
    make: "ایران خودرو دیزل",
    makeEn: "Iran Khodro Diesel",
    country: "ایران",
    assembler: "ایران خودرو دیزل",
    founded: 1963,
    description: "مونتاژ کامیون‌های ایتال‌ایرکو، فاو، دانگ‌فنگ و ساینوتروک.",
    models: ["IVECO Stralis", "FAW J6", "دانگ‌فنگ KL", "SINOTRUK Howo", "Shacman X3000"],
  },
  { make: "SINOTRUK", country: "چین", models: ["Howo 380", "Howo 420", "Howo 440", "T7H", "T5G"] },
  { make: "FAW", country: "چین", models: ["J6", "J5", "J7", "Xiali"] },
  { make: "Dongfeng", country: "چین", models: ["KL", "KR", "KC", "T-Lift"] },
  { make: "Shacman", country: "چین", models: ["X3000", "F3000", "M3000", "H3000"] },
  { make: "Foton", country: "چین", models: ["Auman", "Aumark", "View", "Ollin"] },
  { make: "JAC Trucks", country: "چین", models: ["N-Series", "K-Series", "H-Series"] },

  // Buses
  { make: "Mercedes-Benz Buses", country: "آلمان", models: ["O 530 Citaro", "O 350", "O 500", "Tourismo", "Travego"] },
  { make: "Volvo Buses", country: "سوئد", models: ["B11R", "B8R", "B9R", "7900", "9700"] },
  { make: "Setra", country: "آلمان", models: ["S 415", "S 416", "S 516", "S 531 DT"] },
  {
    make: "ایران خودرو (اتوبوس)",
    makeEn: "Iran Khodro Bus",
    country: "ایران",
    assembler: "ایران خودرو (اتوبوس)",
    description: "مونتاژ اتوبوس‌های بنز، ایتال و ستاره.",
    models: ["O 457", "Setra S 415", "IVECO Eucity", "ایران خودرو اتوبوس شهری"],
  },
  { make: "IVECO Bus", country: "ایتالیا", models: ["Eucity", "Evadys", "Crossway", "Daily minibus"] },
  {
    make: "تکنوبوس",
    makeEn: "TECNOBUS",
    country: "ایران",
    assembler: "تکنوبوس",
    description: "مونتاژ مینی‌بوس‌های استارکس و اسپرینتر.",
    models: ["استارکس مینی‌بوس", "اسپرینتر مینی‌بوس"],
  },

  // Construction equipment
  { make: "Caterpillar", country: "آمریکا", models: ["320 Excavator", "336 Excavator", "390 Excavator", "966 Wheel Loader", "980 Wheel Loader", "14M Grader", "140K Grader", "D6 Bulldozer", "D8 Bulldozer", "D10 Bulldozer"] },
  { make: "Komatsu", country: "ژاپن", models: ["PC200 Excavator", "PC300 Excavator", "PC400 Excavator", "PC800 Excavator", "WA380 Loader", "WA470 Loader", "WA600 Loader", "D65 Bulldozer", "D85 Bulldozer", "GD655 Grader"] },
  { make: "Hitachi", country: "ژاپن", models: ["ZX200 Excavator", "ZX350 Excavator", "ZX490 Excavator", "ZX870 Excavator", "ZW310 Loader", "ZW370 Loader"] },
  { make: "Liebherr", country: "آلمان", models: ["R 926 Excavator", "R 956 Excavator", "R 976 Excavator", "L 566 Loader", "L 586 Loader", "PR 736 Bulldozer", "PR 756 Bulldozer"] },
  { make: "Volvo CE", country: "سوئد", models: ["EC220 Excavator", "EC380 Excavator", "EC480 Excavator", "EC750 Excavator", "L120H Loader", "L150H Loader", "L180H Loader", "G946 Grader"] },
  { make: "JCB", country: "انگلیس", models: ["JS220 Excavator", "JS370 Excavator", "3CX Backhoe", "4CX Backhoe", "457 Wheel Loader", "Robot 190"] },
  { make: "Doosan", country: "کره جنوبی", models: ["DX225 Excavator", "DX380 Excavator", "DX490 Excavator", "M101 Wheel Loader", "M121 Wheel Loader"] },
  { make: "Hyundai CE", country: "کره جنوبی", models: ["R220 Excavator", "R300 Excavator", "R380 Excavator", "HL760 Loader", "HL757 Loader"] },
  { make: "SANY", country: "چین", models: ["SY215 Excavator", "SY335 Excavator", "SY365 Excavator", "SY550 Excavator", "SYL956 Loader", "SYL953 Loader"] },
  { make: "XCMG", country: "چین", models: ["XE215 Excavator", "XE335 Excavator", "XE490 Excavator", "LW500K Loader", "LW600K Loader", "GR180 Grader", "GR215 Grader"] },
  { make: "LiuGong", country: "چین", models: ["CLG922E Excavator", "CLG936E Excavator", "CLG855N Loader", "CLG856H Loader"] },
  { make: "Case CE", country: "آمریکا", models: ["CX210 Excavator", "CX290 Excavator", "621G Loader", "721G Loader"] },
  { make: "New Holland", country: "ایتالیا", models: ["E215B Excavator", "E245B Excavator", "W230B Loader", "W270B Loader"] },
  { make: "Bobcat", country: "آمریکا", models: ["E35 Excavator", "E50 Excavator", "S650 Skid Steer", "S850 Skid Steer"] },

  // Iranian heavy equipment
  {
    make: "هپکو (صنایع سنگین)",
    makeEn: "Hepco Industrial",
    country: "ایران",
    assembler: "هپکو (آراک)",
    founded: 1974,
    description: "بزرگ‌ترین تولیدکننده ماشین‌آلات سنگین ایران.",
    models: ["هپکو بیل مکانیکی HE-220", "هپکو لودر HL-180", "هپکو بولدوزر HD-200"],
  },
  {
    make: "تراکتورسازی تبریز",
    makeEn: "Tabriz Tractor",
    country: "ایران",
    assembler: "تراکتورسازی تبریز",
    founded: 1966,
    description: "تولید تراکتور کشاورزی.",
    models: ["MF-285", "MF-399", "MF-240", "تبریز 6500"],
  },

  // Agriculture
  { make: "John Deere", country: "آمریکا", models: ["5075M Tractor", "6155M Tractor", "6215R Tractor", "8360R Tractor", "W210 Combine", "S660 Combine"] },
  { make: "Massey Ferguson", country: "آمریکا", models: ["MF-240 Tractor", "MF-285 Tractor", "MF-385 Tractor", "MF-399 Tractor", "MF-5445 Tractor"] },
  { make: "New Holland Agriculture", country: "ایتالیا", models: ["T7.270 Tractor", "TD5.90 Tractor", "CR8.90 Combine", "CX8.80 Combine"] },

  // Generators
  { make: "Caterpillar Generator", country: "آمریکا", models: ["C9 Generator", "C18 Generator", "C32 Generator", "3512 Generator", "3516 Generator"] },
];

// ──────────── Helpers ────────────

// Get makes for a given mode
export function getMakesForMode(mode: "passenger" | "heavy"): VehicleMake[] {
  if (mode === "heavy") return HEAVY_MAKES;
  return PASSENGER_MAKES.filter((make) =>
    !isExcludedPassengerMake(make.make) &&
    !isExcludedPassengerMake(make.makeEn) &&
    !isExcludedPassengerMake(make.assembler)
  );
}

// Get only Iranian assemblers/importers (for the catalog page)
export function getIranianMakes(mode: "passenger" | "heavy" = "passenger"): VehicleMake[] {
  return getMakesForMode(mode).filter((m) => m.country === "ایران" && (!!m.assembler || !!m.makeEn));
}

// Get the rich catalog entry for a specific make+model
export function getModelMeta(make: string, modelName: string): VehicleModel | undefined {
  // Match by Persian make OR English makeEn
  const makeObj = getMakesForMode("passenger").find((m) => m.make === make || (m.makeEn && m.makeEn === make))
    || HEAVY_MAKES.find((m) => m.make === make || (m.makeEn && m.makeEn === make));
  return makeObj?.catalog?.find((c) => c.name === modelName);
}

// Find a make by name (Persian or English) — useful for backward compatibility
export function findMake(makeName: string): VehicleMake | undefined {
  return getMakesForMode("passenger").find((m) => m.make === makeName || (m.makeEn && m.makeEn === makeName))
    || HEAVY_MAKES.find((m) => m.make === makeName || (m.makeEn && m.makeEn === makeName));
}

// Segment label (fa/en) for display
export const SEGMENT_LABELS: Record<VehicleSegment, { fa: string; en: string }> = {
  sedan: { fa: "سدان", en: "Sedan" },
  hatchback: { fa: "هاچ‌بک", en: "Hatchback" },
  liftback: { fa: "لیفت‌بک", en: "Liftback" },
  suv: { fa: "شاسی‌بلند", en: "SUV" },
  crossover: { fa: "کراس‌اوور", en: "Crossover" },
  pickup: { fa: "وانت", en: "Pickup" },
  van: { fa: "ون", en: "Van" },
  minibus: { fa: "مینی‌بوس", en: "Minibus" },
  coupe: { fa: "کوپه", en: "Coupe" },
  ev: { fa: "الکتریکی", en: "EV" },
  commercial: { fa: "تجاری", en: "Commercial" },
};

// Fuel label (fa/en)
export const FUEL_LABELS: Record<VehicleFuel, { fa: string; en: string }> = {
  petrol: { fa: "بنزینی", en: "Petrol" },
  diesel: { fa: "دیزلی", en: "Diesel" },
  hybrid: { fa: "هایبرید", en: "Hybrid" },
  ev: { fa: "الکتریکی", en: "Electric" },
  cng: { fa: "دوگانه‌سوز CNG", en: "CNG" },
  lpg: { fa: "گاز مایع LPG", en: "LPG" },
};
