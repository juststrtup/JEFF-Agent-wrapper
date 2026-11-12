import math
import unittest

from understanding import STAGES, WEIGHTS, calculate_understood, calculate_vision


class UnderstandingFormulaTests(unittest.TestCase):
    def test_understood_percentage_uses_fixed_weights_and_defaults_missing_slots_to_zero(self):
        self.assertEqual(calculate_understood({}), 0.0)
        self.assertAlmostEqual(
            calculate_understood({"pricing": 1.0}),
            100.0 * WEIGHTS["pricing"] / sum(WEIGHTS.values()),
        )
        self.assertEqual(calculate_understood(dict.fromkeys(WEIGHTS, 1.0)), 100.0)

    def test_understood_scores_are_clamped_and_invalid_values_rejected(self):
        expected = 100.0 * WEIGHTS["pricing"] / sum(WEIGHTS.values())
        self.assertAlmostEqual(calculate_understood({"pricing": 2.0}), expected)
        self.assertAlmostEqual(calculate_understood({"pricing": -1.0}), 0.0)
        with self.assertRaises(ValueError):
            calculate_understood({"pricing": True})
        with self.assertRaises(ValueError):
            calculate_understood({"pricing": math.nan})

    def test_vision_percentage_uses_fixed_stage_weights(self):
        self.assertEqual(calculate_vision({}), 0.0)
        self.assertAlmostEqual(
            calculate_vision({"first_revenue": True}),
            100.0 * STAGES["first_revenue"] / sum(STAGES.values()),
        )
        self.assertEqual(calculate_vision(dict.fromkeys(STAGES, True)), 100.0)
        self.assertEqual(calculate_vision({"first_revenue": "true"}), 0.0)


if __name__ == "__main__":
    unittest.main()
