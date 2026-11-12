"""Fixed startup-understanding and vision weights and their percentage formulas."""

from collections.abc import Mapping
from math import isfinite

SLOTS = (
    "problem",
    "icp",
    "product",
    "business_model",
    "pricing",
    "traction",
    "moat",
    "gtm",
    "team",
    "risks",
    "ask",
)

WEIGHTS = {
    "problem": 1.0,
    "icp": 1.2,
    "product": 1.0,
    "business_model": 1.4,
    "pricing": 1.2,
    "traction": 1.4,
    "moat": 0.8,
    "gtm": 1.1,
    "team": 0.7,
    "risks": 0.8,
    "ask": 0.9,
}

STAGES = {
    "problem_validated": 1,
    "mvp_shipped": 2,
    "first_users": 2,
    "first_revenue": 3,
    "retention_proven": 3,
    "repeatable_gtm": 3,
    "scale": 2,
}


def _clamp_score(value: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("slot scores must be numbers")
    score = float(value)
    if not isfinite(score):
        raise ValueError("slot scores must be finite numbers")
    return max(0.0, min(1.0, score))


def calculate_understood(scores: Mapping[str, float]) -> float:
    """Return the weighted percentage, treating missing fixed slots as zero."""
    total_weight = sum(WEIGHTS.values())
    weighted_score = sum(
        WEIGHTS[slot] * _clamp_score(scores.get(slot, 0.0))
        for slot in SLOTS
    )
    return 100.0 * weighted_score / total_weight


def calculate_vision(stages: Mapping[str, bool]) -> float:
    """Return the weighted percentage of completed fixed vision stages."""
    total_weight = sum(STAGES.values())
    completed_weight = sum(
        weight for stage, weight in STAGES.items() if stages.get(stage) is True
    )
    return 100.0 * completed_weight / total_weight
