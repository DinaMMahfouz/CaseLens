from scripts.golden_agreement import agreement


def test_agreement_metrics_per_dimension():
    golden = [
        {"case_number": "A", "scores": {"troubleshooting": 4, "slo": "MET", "communication": None}},
        {"case_number": "B", "scores": {"troubleshooting": 2, "slo": "BREACHED"}},
    ]
    machine = {"A": {"troubleshooting": 4, "slo": "MET", "communication": 3},
               "B": {"troubleshooting": 4.0, "slo": "MET"}}
    r = agreement(golden, machine)
    assert r["troubleshooting"] == {"n": 2, "exact": 0.5, "within_1": 0.5, "mae": 1.0}
    assert r["slo"] == {"n": 2, "exact": 0.5}
    assert r["communication"] == {"n": 0}          # human did not score it
