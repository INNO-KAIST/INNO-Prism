"""Build a Python reference result for the power-scan fitting engine by exec-ing
the relevant pure-math sections of the original inno_data_analyzer.py (no Qt).
Outputs JSON with loaded data, preprocess, segment fit, and full analysis per file.

이것은 **일회성 생성기**이며 회귀 검사가 아니다. 입력인 `inno_data_analyzer.py`
(Qt 기반 구형 분석기)는 이 저장소에 없다 — 전환 당시의 외부 파일이다.
회귀 검사가 실제로 읽는 것은 이 스크립트가 한 번 만들어 둔 결과 `py_reference.json`
이고(`tests/test_engine.js`), 그 파일은 저장소에 들어 있다.

따라서 이 스크립트는 평소에 실행되지 않는다. 다시 돌려야 할 때만 경로를 준다:

    INNO_ANALYZER=/경로/inno_data_analyzer.py \
    PY_REF_OUT=tests/py_reference.json \
    python tests/py_reference.py

경로를 주지 않으면 무엇이 없어서 못 도는지 밝히고 종료한다 — 조용히 실패하거나
남의 PC 경로를 가리킨 채 죽지 않게 하기 위함이다.
"""
import os
import json, sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_ANALYZER = os.environ.get("INNO_ANALYZER")
if not _ANALYZER:
    sys.exit(
        "py_reference.py: 입력 분석기 경로가 없습니다.\n"
        "  이 스크립트는 일회성 생성기이며, 입력 inno_data_analyzer.py 는 저장소에 없습니다.\n"
        "  회귀 검사는 이미 생성된 tests/py_reference.json 을 읽으므로 평소에는 실행할 필요가 없습니다.\n"
        "  다시 생성하려면: INNO_ANALYZER=/경로/inno_data_analyzer.py python tests/py_reference.py"
    )
if not Path(_ANALYZER).exists():
    sys.exit(f"py_reference.py: INNO_ANALYZER 경로가 없습니다 — {_ANALYZER}")

import numpy as np
import h5py
from pathlib import Path
from dataclasses import dataclass, field, fields as dc_fields
from typing import Any, Dict, List, Optional, Sequence, Tuple
from scipy.signal import savgol_filter
import scipy.optimize

SRC = Path(_ANALYZER).read_text(encoding="utf-8")
LINES = SRC.split("\n")

ns: Dict[str, Any] = {
    "np": np, "h5py": h5py, "Path": Path, "json": json,
    "dataclass": dataclass, "field": field,
    "Any": Any, "Dict": Dict, "List": List, "Optional": Optional,
    "Sequence": Sequence, "Tuple": Tuple,
    "savgol_filter": savgol_filter, "Figure": object, "ROOT": Path("/tmp"), "TOOLTIPS": {},
}

def ex(a, b):
    """exec source lines a..b (1-indexed, inclusive)"""
    code = "\n".join(LINES[a - 1:b])
    exec(compile(code, f"inno[{a}:{b}]", "exec"), ns)

# constants & keys
ex(283, 294)
# core dataclasses (LoadedData .. GenericPreviewData)
ex(438, 562)
# helper functions (safe_mean_std .. ascii formatters); stop before figure builders
ex(566, 676)
# odd_at_least_one etc.
ex(1671, 1674)
# loaders + branch split
ex(1868, 1959)
ex(2038, 2110)
# constants + smoothing presets + analysis dataclasses
ex(2112, 2434)
# smoothing / direction / monotonicity / preprocess / replicate stats / baselines
ex(2436, 2792)
# information criteria + percentile pair
ex(2859, 2881)
# pct agreement
ex(3287, 3294)
# dataclass instance helper
ex(7752, 7759)
# safe log sigma
ex(7775, 7786)
# evaluate_pa_fit_quality (final override)
ex(7986, 8011)
# saturating models, WLS, segment fit (exact O(n^2) version), sigma estimation, initial guess
ex(8248, 8465)
# residual stats (fast1 original)
ns["_sf_safe_log_residual_stats_fast1"] = None
ex(8923, 8976)
ns["_sf_safe_log_residual_stats_fast1"] = ns["_sf_safe_log_residual_stats"]
# quantile baseline, poor shape, fit selection score
ex(9125, 9157)
# v5 model family engine + fit_single + analyze_branch (stop before plotting)
ex(9684, 10299)

def jsonable(v):
    if isinstance(v, np.ndarray):
        return [None if not np.isfinite(x) else float(x) for x in np.asarray(v, dtype=float).ravel()]
    if isinstance(v, (np.floating, float)):
        return None if not np.isfinite(v) else float(v)
    if isinstance(v, (np.integer, int)):
        return int(v)
    if isinstance(v, (list, tuple)):
        return [jsonable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): jsonable(x) for k, x in v.items()}
    return v

def fit_summary(fit):
    return {
        "fit_name": fit.fit_name, "success": bool(fit.success), "message": fit.message,
        "kind": str(getattr(fit, "fit_method", "")),
        "baseline_model": str(getattr(fit, "baseline_model", "")),
        "baseline_B": jsonable(fit.baseline_B), "amplitude_A": jsonable(fit.amplitude_A),
        "steepness_k": jsonable(fit.steepness_k), "center_Pc": jsonable(fit.center_Pc),
        "r2": jsonable(fit.r2), "rmse": jsonable(fit.rmse),
        "weighted_rmse": jsonable(getattr(fit, "weighted_rmse", np.nan)),
        "aic": jsonable(fit.aic), "bic": jsonable(fit.bic),
        "pa_slope_segment": jsonable(fit.slope_at_transition),
        "threshold_power": jsonable(fit.threshold_segmented_intersection),
        "saturation_power": jsonable(fit.threshold_guide_intercept),
        "n_points": int(fit.n_points), "n_params": int(fit.n_params),
    }

def analyze_file(path, branch_name="up", band=(480.0, 680.0)):
    loaded = ns["load_power_scan_data"](Path(path), band[0], band[1])
    branches = ns["split_loaded_data_into_branches"](loaded)
    branch = ns["get_branch_for_name"](branches, branch_name)
    analysis = ns["analyze_branch_loglog_pa"](
        branch, smoothing_level=2, monotonicity_tolerance="medium",
        transition_mode="auto", manual_transition_power=None,
        primary_fit="constrained",
    )
    prep = analysis.prep
    seg = ns["_three_line_segment_fit_loglog"](
        np.asarray(prep.x_analysis_for_fit), np.asarray(prep.y_analysis_for_fit),
        sigma_log=ns["_estimate_sigma_log_for_fit"](prep, np.asarray(prep.y_analysis_for_fit)),
        min_seg=3,
    )
    return {
        "file": Path(path).name,
        "data_type": loaded.data_type,
        "scan_mode": branches.scan_mode,
        "peak_index": int(branches.peak_index_all),
        "n_raw": len(loaded.x_raw_avg),
        "branch": branch_name,
        "x_raw_avg_head": jsonable(np.asarray(loaded.x_raw_avg)[:5]),
        "y_raw_avg_head": jsonable(np.asarray(loaded.y_raw_avg)[:5]),
        "prep": {
            "n_analysis": len(prep.x_analysis_for_fit),
            "nonmonotonic": int(prep.nonmonotonic_point_count),
            "transition_power": jsonable(prep.transition_power),
            "dynamic_range_ratio": jsonable(prep.dynamic_range_ratio),
            "baseline_est": jsonable(prep.derivative_baseline_estimate),
            "x": jsonable(np.asarray(prep.x_analysis_for_fit)),
            "y": jsonable(np.asarray(prep.y_analysis_for_fit)),
            "y_std": jsonable(np.asarray(prep.analysis_intensity_std)),
            "y_sem": jsonable(np.asarray(prep.analysis_intensity_sem)),
        },
        "segment": {
            "pa_slope": jsonable(seg["pa_slope"]),
            "pa_slope_err": jsonable(seg["pa_slope_err"]),
            "threshold_power": jsonable(seg["threshold_power"]),
            "saturation_power": jsonable(seg["saturation_power"]),
            "slopes": jsonable(seg["slopes"]),
            "saturation_observed": bool(seg["saturation_observed"]),
        },
        "unconstrained": fit_summary(analysis.unconstrained),
        "constrained": fit_summary(analysis.constrained),
        "primary": analysis.primary_fit_name,
        "quality": {
            "score": jsonable(analysis.fit_quality.score),
            "level": analysis.fit_quality.level,
            "gof": jsonable(analysis.fit_quality.goodness_of_fit),
            "consistency": jsonable(analysis.fit_quality.model_consistency),
            "sufficiency": jsonable(analysis.fit_quality.data_sufficiency),
            "dyn": jsonable(analysis.fit_quality.dynamic_range_adequacy),
        },
    }

if __name__ == "__main__":
    ex_dir = Path("/mnt/user-data/uploads/inno_optics/EXE/dist/INNO Data Analyzer/examples")
    results = []
    apd = ex_dir / "260430_(power_scan)_WJ-0041c #1.h5"
    emccd = ex_dir / "250623_145548_[20%Tm_AS-35]_(800nmPL_exp1s)_power_scan.h5"
    for path, branch in [(apd, "up"), (apd, "down"), (emccd, "up")]:
        try:
            results.append(analyze_file(path, branch))
            print(f"OK {path.name} [{branch}]")
        except Exception as e:
            results.append({"file": path.name, "branch": branch, "error": str(e)})
            print(f"FAIL {path.name} [{branch}]: {e}")
    Path(os.environ.get("PY_REF_OUT", _HERE / "py_reference.json")).write_text(json.dumps(results, indent=1))
    print("wrote py_reference.json")
