"""Exercise bot decisions against real rules, including unlucky dice."""
import copy
import json
from pathlib import Path
import random
import unittest

from tools.playtest_bots import Policy, check_transition

ROOT = Path(__file__).resolve().parents[1]


class BotPolicyTests(unittest.TestCase):
    def test_policy_completes_quest_and_continues_without_changing_rules(self):
        for seed in (7, 21, 59):
            with self.subTest(seed=seed):
                policy = Policy(ROOT)
                rng = random.Random(seed)
                state = policy.engine.run('createCharacter', None, {'profile': {
                    'name': 'Тест', 'sex': 'male', 'race': 'dwarf', 'origin': 'dwarf', 'class': 'warrior'}})
                memory = {'shifts': 0}
                finished_at = None
                for step in range(1500):
                    # Flask's HTTP response sorts nested object keys. The bot
                    # must be able to decide from that representation too.
                    method, args = policy.decide(json.loads(json.dumps(state, sort_keys=True)), memory)
                    after = policy.engine.run(method, state, args, [rng.getrandbits(32) for _ in range(128)])
                    self.assertEqual(check_transition(state, after, method, args), [])
                    state = after
                    if method == 'finishWork': memory['shifts'] += 1
                    if state['quest'] == 'complete' and finished_at is None: finished_at = step
                    if finished_at is not None and step >= finished_at + 100 and memory['shifts'] > 12: break
                self.assertIsNotNone(finished_at, f'Bot stalled: {state["position"]}, {state["hero"]}, {memory}')
                self.assertGreater(memory['shifts'], 12)

    def test_work_arithmetic_checker_catches_bad_reward(self):
        before = {'ticks': 0, 'turn': 0, 'hero': {'coins': 1}}
        after = {'ticks': 3, 'turn': 0, 'phase': 'work-result', 'job': {'roll': 6},
                 'hero': {'coins': 5, 'food': 0, 'experience': 0, 'potions': 0, 'hp': 1, 'maxHp': 16}}
        self.assertIn('work_pay_mismatch', check_transition(before, after, 'finishWork', {}))

    def test_low_resources_do_not_make_policy_request_unaffordable_rest(self):
        policy = Policy(ROOT)
        state = policy.engine.run('createCharacter', None, {'profile': {
            'name': 'Тест', 'sex': 'male', 'race': 'dwarf', 'origin': 'dwarf', 'class': 'warrior'}})
        state['hero'].update(hp=1, food=0, coins=0, potions=0)
        state['position'] = policy.cells['forge']
        original = copy.deepcopy(state)
        method, args = policy.decide(state, {'shifts': 0})
        self.assertEqual((method, args), ('service', {'action': 'work-forge'}))
        self.assertEqual(state, original)


if __name__ == '__main__':
    unittest.main()
