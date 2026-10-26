"""Summarize collected synthetic burst results without printing credentials."""

from __future__ import annotations

import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

NORMAL_REJECTIONS = {'FW-003', 'CHAT-012', 'CHAT-013', 'CHAT-021', 'CHAT-022', 'CHAT-023', 'LLM-006', 'LLM-008'}

def outcome(status, error):
    if status == 'SUCCEEDED':
        return 'ANSWERED'
    if error in NORMAL_REJECTIONS:
        return 'NORMAL_REJECTION'
    if status in {'QUEUED', 'RUNNING'}:
        return 'INCOMPLETE'
    return 'SYSTEM_ERROR'


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))

def percentile(values, fraction):
    values=sorted(values)
    if not values:
        return None
    index=(len(values)-1)*fraction
    low=int(index)
    high=min(low+1,len(values)-1)
    return round(values[low]+(values[high]-values[low])*(index-low),3)


def main() -> None:
    directory = Path(sys.argv[1])
    plan = read_json(directory / "plan.json")
    jobs = read_json(directory / "jobs.json")["jobs"]
    events = []
    for line in (directory / "submissions.ndjson").read_text(encoding="utf-8-sig").splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        if isinstance(event.get("msg"), str):
            event = json.loads(event["msg"])
        if event.get("type") == "chat-burst-submission":
            events.append(event)
    by_case = {event["caseId"]: event for event in events}
    if len(events) != plan['total'] or set(by_case) != set(range(1, plan['total']+1)):
        raise RuntimeError('Missing or duplicate submission case')
    outcomes = Counter()
    by_probe: dict[str, Counter] = defaultdict(Counter)
    by_category: dict[str, Counter] = defaultdict(Counter)
    answer_lengths = []
    successful_answers = []
    rows = []
    for item in plan["cases"]:
        event = by_case.get(item["caseId"], {})
        job = jobs.get(str(event.get("jobId")), {})
        status = job.get("status") or f"HTTP_{event.get('httpStatus', 'MISSING')}"
        error = None if status == "SUCCEEDED" else (job.get("errorCode") or event.get("code"))
        answer = job.get("answer")
        outcomes[status] += 1
        by_probe[item["probe"]][status] += 1
        by_category[item["category"]][status] += 1
        if answer:
            answer_lengths.append(len(answer))
            if status == "SUCCEEDED":
                successful_answers.append(answer)
        rows.append({
            "caseId": item["caseId"],
            "faqId": item["faqId"],
            "category": item["category"],
            "probe": item["probe"],
            "question": item["question"],
            "httpStatus": event.get("httpStatus"),
            "jobId": event.get("jobId"),
            "status": status,
            "errorCode": error,
            "outcome": outcome(status, error),
            "answer": answer,
        })
    summary = {
        "runId": plan["runId"],
        "total": plan["total"],
        "submitted": len(events),
        "httpStatuses": dict(Counter(str(event['httpStatus']) for event in events)),
        "transportErrors": dict(Counter(str(event['transportErrorCode']) for event in events if event.get('transportErrorCode'))),
        "connectionWarmupReady": sum(event.get('warmupStatus') == 200 for event in events),
        "uniqueJobIds": len({event['jobId'] for event in events if event.get('jobId') is not None}),
        "postResponseMs": {'p50':percentile([e['elapsedMs'] for e in events],.5), 'p95':percentile([e['elapsedMs'] for e in events],.95), 'max':max(e['elapsedMs'] for e in events)},
        "postStartSpreadMs": max(e['startedAt'] for e in events)-min(e['startedAt'] for e in events),
        "statuses": dict(outcomes),
        "outcomes": dict(Counter(row['outcome'] for row in rows)),
        "normalRejections": dict(Counter(row['errorCode'] for row in rows if row['outcome'] == 'NORMAL_REJECTION')),
        "systemErrors": dict(Counter(row['errorCode'] or row['status'] for row in rows if row['outcome'] == 'SYSTEM_ERROR')),
        "errors": dict(Counter(row["errorCode"] for row in rows if row["errorCode"])),
        "byProbe": {key: dict(value) for key, value in by_probe.items()},
        "categories": len(by_category),
        "answerLength": {
            "min": min(answer_lengths) if answer_lengths else None,
            "median": statistics.median(answer_lengths) if answer_lengths else None,
            "max": max(answer_lengths) if answer_lengths else None,
        },
        "emptySuccessfulAnswers": sum(row["status"] == "SUCCEEDED" and not row["answer"] for row in rows),
        "uniqueSuccessfulAnswers": len(set(successful_answers)),
        "genericDeferralAnswers": sum(
            answer == "문의하신 내용은 현재 안내 자료로는 확인해 드리기 어렵습니다."
            for answer in successful_answers
        ),
        "containsGenericDeferral": sum(
            "현재 안내 자료로는 확인해 드리기 어렵습니다" in answer
            for answer in successful_answers
        ),
        "nonTerminalEnding": sum(
            not answer.strip().endswith((".", "!", "?", "요", "다", "…"))
            for answer in successful_answers
        ),
    }
    (directory / "analysis-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (directory / "analysis-rows.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
