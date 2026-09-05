import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "src"))
from greet import greeting


class GreetingTest(unittest.TestCase):
    def test_greeting(self):
        self.assertEqual(greeting("Loop"), "Hello, Loop!")

