"""Build two distinct 3,000-question quality/load batches from FAQ variants.

The boundary label is a lexical *candidate*. Actual embedding similarity and
routing must be measured in the live pilot; this script never asserts them.
"""

from __future__ import annotations

import csv
import hashlib
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path


ROOT = next(parent for parent in Path(__file__).resolve().parents
            if (parent / 'UBot-BE' / 'tools' / 'faq-db' / 'seed').is_dir())
SEED = ROOT / "UBot-BE" / "tools" / "faq-db" / "seed"
OUT = Path(__file__).resolve().parent / "dataset"
TARGET_PER_RUN = 3000
BOUNDARY_PER_RUN = 300
MAX_PER_FAQ = 8

# 개인별 이용 정보 조회 요청을 제외함. 처리 방법을 묻는 일반 FAQ도 보수적으로 걸러냄
PERSONAL = re.compile(
    r"(?:나의|저의|제|내)\s*(?:명의|요금|청구|납부|결제|회선|번호|가입|약정|계약|할부|예약|주소|정보|사용|이용|잔여|남은|데이터|멤버십|포인트|혜택)"
    r"|(?:현재|지금)\s*(?:가입|사용|이용)\s*(?:중인|하는)"
    r"|(?:잔여|남은|이번\s*달|이번달|최근|지난달|지난\s*달).*?(?:데이터|통화량|요금|청구|납부|결제|이용량|사용량|내역|포인트)"
    r"|(?:명의|가입|납부|청구|결제|예약|통화|문자|사용|이용)\s*(?:내역|정보|현황|상태).*?(?:알려|조회|확인|보여)"
    r"|(?:약정|계약)\s*(?:종료일|만료일|남은\s*기간)"
)


def normalized(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    return "".join(char for char in value if char.isalnum())


def grams(value: str) -> set[str]:
    value = normalized(value)
    return {value[i : i + 2] for i in range(len(value) - 1)}


def jaccard(left: set[str], right: set[str]) -> float:
    return len(left & right) / len(left | right) if left and right else 0.0


def stable_key(faq_id: int, question: str) -> str:
    return hashlib.sha256(f"diverse-6000-v1|{faq_id}|{question}".encode()).hexdigest()


def contextualize(faq_id: int, variant: str, boundary: bool) -> str:
    prefixes = (
        ("비슷한 안내가 여러 개라 헷갈립니다. ", "어느 기준을 따라야 할지 애매해서요. ",
         "관련된 항목이 비슷해 구분이 어렵습니다. ", "제 상황에 적용되는 안내를 찾고 있어요. ")
        if boundary else
        ("처음 이용하는 상황이라 확인하고 싶어요. ", "직접 처리하기 전에 알고 싶습니다. ",
         "안내를 읽었는데 다시 확인하고 싶어요. ", "고객센터에 묻기 전에 확인할게요. ")
    )
    index = int(stable_key(faq_id, variant)[:8], 16) % len(prefixes)
    return prefixes[index] + variant


def main() -> None:
    with (SEED / "baseline-faqs.csv").open(encoding="utf-8-sig", newline="") as file:
        all_faqs = {int(row["faqId"]): row for row in csv.DictReader(file)}
    live = json.loads((OUT / "live-faq-metadata.json").read_text(encoding="utf-8"))
    personal_ids = set(live["personal"])
    excluded = Counter()
    (OUT / "active-faq-ids.json").write_text(json.dumps(live["active"]), encoding="utf-8")
    patches_path = OUT / "live-faq-patches.json"
    changed_question_ids = set()
    if patches_path.exists():
        for patch in json.loads(patches_path.read_text(encoding="utf-8")):
            faq_id = int(patch["id"])
            if all_faqs[faq_id]["question"] != patch["question"]:
                changed_question_ids.add(faq_id)
            all_faqs[faq_id].update({
                "question": patch["question"],
                "answer": patch["answer"],
                "category": patch["category"],
            })
    canonical = {normalized(row["question"]) for row in all_faqs.values()}
    active_path = OUT / "active-faq-ids.json"
    if active_path.exists():
        active_ids = set(json.loads(active_path.read_text(encoding="utf-8")))
        faqs = {faq_id: row for faq_id, row in all_faqs.items()
                if faq_id in active_ids and faq_id not in changed_question_ids}
    else:
        faqs = all_faqs
    faq_grams = {faq_id: grams(row["question"]) for faq_id, row in faqs.items()}
    by_category: dict[str, list[int]] = defaultdict(list)
    for faq_id, faq in faqs.items():
        by_category[faq["category"]].append(faq_id)

    candidates = []
    seen = set()
    with (SEED / "baseline-faq-variants.csv").open(encoding="utf-8-sig", newline="") as file:
        indexed_variants = {normalized(row["question"]) for row in csv.DictReader(file)}
    with (SEED / "baseline-faq-variants.csv").open(encoding="utf-8-sig", newline="") as file:
        for row in csv.DictReader(file):
            faq_id = int(row["originFaqId"])
            faq = faqs.get(faq_id)
            if not faq:
                continue
            if faq_id in personal_ids or faq["intent"] == "USER_DATA":
                excluded["personalIntentVariants"] += 1
                continue
            question = " ".join(row["question"].split())
            if PERSONAL.search(question) or PERSONAL.search(faq["question"]):
                excluded["personalQuestionVariants"] += 1
                continue
            key = normalized(question)
            if key in canonical or not 4 <= len(question) <= 180:
                continue
            if "바보" in question:
                continue
            qgrams = grams(question)
            own = jaccard(qgrams, faq_grams[faq_id])
            competing = max(
                (jaccard(qgrams, faq_grams[other]) for other in by_category[faq["category"]]
                 if other != faq_id),
                default=0.0,
            )
            # Competing FAQs with similar lexical scores are plausible margin cases.
            # This does not estimate the production embedding score.
            probe = "boundary" if min(own, competing) >= 0.24 and abs(own - competing) <= 0.17 else "variant"
            novel_question = contextualize(faq_id, question, probe == "boundary")
            novel_key = normalized(novel_question)
            if novel_key in canonical or novel_key in indexed_variants or novel_key in seen:
                continue
            seen.add(novel_key)
            candidates.append({
                "question": novel_question,
                "sourceVariant": question,
                "faqId": faq_id,
                "category": faq["category"],
                "probe": probe,
                "referenceAnswer": faq["answer"],
                "lexicalOwn": round(own, 3),
                "lexicalCompetitor": round(competing, 3),
            })

    # 부족한 문항은 일반 FAQ의 서술을 바꿔 보충함. 개인정보 질문을 다시 넣지 않음
    endings = (
        ("할 수 있나요?", "가능한지 알고 싶어요."),
        ("어떻게 하나요?", "진행 방법이 궁금해요."),
        ("무엇인가요?", "어떤 것인지 쉽게 설명해 주세요."),
        ("얼마인가요?", "비용이 어느 정도인지 알려 주세요."),
        ("가능한가요?", "가능 여부와 조건을 알려 주세요."),
        ("있나요?", "있는지 확인하고 싶어요."),
        ("되나요?", "되는지 궁금해요."),
        ("하나요?", "하는지 알려 주세요."),
        ("인가요?", "인지 궁금해요."),
    )
    for faq_id, faq in faqs.items():
        if faq_id in personal_ids or faq['intent'] == 'USER_DATA' or PERSONAL.search(faq['question']):
            continue
        paraphrase = faq['question']
        for ending, replacement in endings:
            if paraphrase.endswith(ending):
                paraphrase = paraphrase[:-len(ending)] + replacement
                break
        key = normalized(paraphrase)
        if key in canonical or key in indexed_variants or key in seen or PERSONAL.search(paraphrase):
            continue
        seen.add(key)
        candidates.append({
            'question': paraphrase, 'sourceVariant': faq['question'], 'faqId': faq_id,
            'category': faq['category'], 'probe': 'variant', 'referenceAnswer': faq['answer'],
            'lexicalOwn': round(jaccard(grams(paraphrase), faq_grams[faq_id]), 3),
            'lexicalCompetitor': None,
        })

    pools: dict[str, dict[str, dict[int, list[dict]]]] = {
        "variant": defaultdict(lambda: defaultdict(list)),
        "boundary": defaultdict(lambda: defaultdict(list)),
    }
    for item in candidates:
        pools[item["probe"]][item["category"]][item["faqId"]].append(item)
    for probe in pools:
        for category in pools[probe]:
            for faq_id in pools[probe][category]:
                pools[probe][category][faq_id].sort(key=lambda x: stable_key(faq_id, x["question"]))
    print("Candidate counts:", dict(Counter(item["probe"] for item in candidates)))

    selected: list[list[dict]] = [[], []]
    category_counts = Counter()
    faq_counts = Counter()

    def pick(probe: str, run: int) -> None:
        eligible = []
        for category, faq_pool in pools[probe].items():
            faq_ids = [faq_id for faq_id, items in faq_pool.items()
                       if items and faq_counts[faq_id] < MAX_PER_FAQ]
            if faq_ids:
                eligible.append((category_counts[category], category, faq_ids))
        if not eligible:
            raise RuntimeError(f"Not enough {probe} candidates for {TARGET_PER_RUN} per run")
        _, category, faq_ids = min(eligible)
        faq_id = min(faq_ids, key=lambda value: (faq_counts[value], value))
        item = pools[probe][category][faq_id].pop(0)
        selected[run].append(item)
        category_counts[category] += 1
        faq_counts[faq_id] += 1

    for _ in range(BOUNDARY_PER_RUN):
        pick("boundary", 0)
        pick("boundary", 1)
    for _ in range(TARGET_PER_RUN - BOUNDARY_PER_RUN):
        pick("variant", 0)
        pick("variant", 1)

    # Mix probes and categories within each burst, retaining deterministic output.
    for run in range(2):
        selected[run].sort(key=lambda x: stable_key(x["faqId"], x["question"]))

    all_items = selected[0] + selected[1]
    keys = [normalized(item["question"]) for item in all_items]
    if len(keys) != 6000 or len(set(keys)) != 6000:
        raise RuntimeError("Cross-run duplicate or incorrect item count")
    if set(keys) & (canonical | indexed_variants):
        raise RuntimeError("A selected question matches a canonical or indexed FAQ question")
    OUT.mkdir(parents=True, exist_ok=True)
    # Reuse a bounded sample of main questions so the pilot validates the
    # exact material that will be sent. Main runs remain mutually disjoint.
    pilot = []
    for probe in ("boundary", "variant"):
        pilot.extend([item for item in all_items if item["probe"] == probe][:50])
    pilot.sort(key=lambda x: stable_key(x["faqId"], x["question"]))
    for run in range(2):
        payload = {"mode": "diverse", "cases": [
            {key: item[key] for key in ("question", "faqId", "category", "probe")}
            for item in selected[run]
        ]}
        (OUT / f"run-{run + 1}-questions.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    (OUT / "pilot-100-questions.json").write_text(
        json.dumps({"mode": "diverse", "cases": [
            {key: item[key] for key in ("question", "faqId", "category", "probe")}
            for item in pilot
        ]}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (OUT / "manifest.json").write_text(
        json.dumps({"source": "baseline-faq-variants.csv", "runs": selected}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    selected_faq_ids = sorted({item["faqId"] for item in all_items})
    fingerprint_text = "|".join(
        f"{faq_id}:{faqs[faq_id]['question']}:{faqs[faq_id]['answer']}"
        for faq_id in selected_faq_ids
    )
    fingerprint = hashlib.md5(fingerprint_text.encode("utf-8")).hexdigest()
    (OUT / "faq-preflight.sql").write_text(
        "BEGIN READ ONLY;\nSET LOCAL statement_timeout = '30s';\n"
        "SELECT json_build_object('count', count(*), "
        "'active', count(*) FILTER (WHERE deleted_at IS NULL), "
        "'fingerprint', md5(coalesce(string_agg(id::text || ':' || question || ':' || answer, '|' ORDER BY id), ''))) "
        "FROM faq WHERE id IN (" + ",".join(map(str, selected_faq_ids)) + ");\nCOMMIT;\n",
        encoding="utf-8",
    )
    expected_rows = ",".join(
        f"({faq_id},'{hashlib.md5(faqs[faq_id]['question'].encode('utf-8')).hexdigest()}',"
        f"'{hashlib.md5(faqs[faq_id]['answer'].encode('utf-8')).hexdigest()}')"
        for faq_id in selected_faq_ids
    )
    (OUT / "faq-compare.sql").write_text(
        "BEGIN READ ONLY;\nSET LOCAL statement_timeout = '30s';\n"
        "WITH expected(id,qhash,ahash) AS (VALUES " + expected_rows + "), differences AS ("
        "SELECT e.id, f.id IS NULL AS missing, "
        "md5(f.question) IS DISTINCT FROM e.qhash AS question_changed, "
        "md5(f.answer) IS DISTINCT FROM e.ahash AS answer_changed "
        "FROM expected e LEFT JOIN faq f ON f.id=e.id AND f.deleted_at IS NULL) "
        "SELECT json_build_object('count',count(*),'missing',count(*) FILTER (WHERE missing),"
        "'questionChanged',count(*) FILTER (WHERE question_changed AND NOT missing),"
        "'answerChanged',count(*) FILTER (WHERE answer_changed AND NOT missing),"
        "'changedIds',coalesce(json_agg(id) FILTER (WHERE question_changed OR answer_changed), '[]'::json)) "
        "FROM differences;\nCOMMIT;\n",
        encoding="utf-8",
    )
    summary = {
        "personalFilter": dict(excluded),
        "personalFaqIdsSelected": sum(item["faqId"] in personal_ids or all_faqs[item["faqId"]]["intent"] == "USER_DATA" for item in all_items),
        "personalQuestionMatches": sum(bool(PERSONAL.search(item["sourceVariant"])) for item in all_items),
        "total": len(all_items),
        "perRun": [len(run) for run in selected],
        "probesPerRun": [dict(Counter(item["probe"] for item in run)) for run in selected],
        "distinctCategories": len({item["category"] for item in all_items}),
        "distinctFaqIds": len({item["faqId"] for item in all_items}),
        "activeFaqFilterApplied": active_path.exists(),
        "liveFaqAnswerPatches": len(json.loads(patches_path.read_text(encoding="utf-8"))) if patches_path.exists() else 0,
        "excludedChangedQuestionFaqs": len(changed_question_ids),
        "faqReferenceFingerprint": fingerprint,
        "exactOrNormalizedFaqMatches": 0,
        "exactOrNormalizedIndexedVariantMatches": 0,
        "crossRunDuplicates": 0,
        "pilotCount": len(pilot),
        "pilotMainOverlaps": len(pilot),
        "maxPerFaq": max(faq_counts.values()),
        "questionLengthRange": [min(map(len, (x["question"] for x in all_items))),
                                max(map(len, (x["question"] for x in all_items)))],
    }
    (OUT / "preflight.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
