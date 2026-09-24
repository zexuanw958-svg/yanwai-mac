import json
import threading
import unittest
import urllib.request
import urllib.error
from server import make_server, render_result

class FakeEngine:
    model = "test-double-not-a-real-model"
    def analyze(self, text):
        return render_result({"intent": {"choice": "action"}, "action": {"choice": "plan"}}, 0.01, False)

class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_server(FakeEngine(), 0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start()
        cls.url = "http://127.0.0.1:" + str(cls.server.server_address[1])
    @classmethod
    def tearDownClass(cls): cls.server.shutdown(); cls.server.server_close(); cls.thread.join()
    def test_health_is_loopback_only(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        self.assertTrue(json.load(urllib.request.urlopen(self.url+"/health"))["ready"])
    def test_browser_origin_is_rejected(self):
        req = urllib.request.Request(self.url+"/health", headers={"Origin": "https://example.com"})
        with self.assertRaises(urllib.error.HTTPError) as caught: urllib.request.urlopen(req)
        self.assertEqual(caught.exception.code, 403)
    def test_response_distinguishes_templates_and_rejects_empty_text(self):
        req=urllib.request.Request(self.url+"/analyze",data=json.dumps({"text":"具体什么时候确认？"}).encode(),headers={"Content-Type":"application/json"})
        value=json.load(urllib.request.urlopen(req))
        self.assertIsNone(value["intentProbabilities"])
        self.assertEqual(value["replySource"],"本地表达模板");self.assertEqual(len(value["replies"]),3)
        req=urllib.request.Request(self.url+"/analyze",data=b'{"text":""}',headers={"Content-Type":"application/json"})
        with self.assertRaises(urllib.error.HTTPError) as caught: urllib.request.urlopen(req)
        self.assertEqual(caught.exception.code,400)
    def test_unknown_labels_do_not_become_confident_claims(self):
        value=render_result({"intent":{"choice":"invented"},"action":{"choice":"invented"}},0,True)
        self.assertIn("信息还不够",value["intent"]);self.assertTrue(value["contextTrimmed"])

class DistributionTest(unittest.TestCase):
    def test_preserves_all_raw_probabilities_separate_from_confidence(self):
        probabilities = {"action": .72, "information": .2, "emotion": .079999, "unclear": .000001}
        value = render_result({"intent": {"choice": "action", "confidence": .99,
            "probabilities": probabilities}}, 0, False)
        self.assertEqual(value["intentProbabilities"], probabilities)
        self.assertEqual(set(value["intentLabels"]), set(probabilities))
        self.assertEqual(value["replySource"], "本地表达模板")
        self.assertEqual(len(value["replies"]), 3)
    def test_missing_and_invalid_values_are_not_filled_or_normalized(self):
        self.assertIsNone(render_result({"intent": {"choice": "action", "confidence": .99}}, 0, False)["intentProbabilities"])
        raw = {"action": .72, "information": float("nan"), "emotion": True, "unclear": -1}
        value = render_result({"intent": {"probabilities": raw}}, 0, False)
        self.assertEqual(value["intentProbabilities"], {"action": .72, "information": None, "emotion": None, "unclear": -1})
        json.dumps(value, allow_nan=False)
        self.assertEqual(render_result({"intent": {"probabilities": {"action": .72}}}, 0, False)["intentProbabilities"], {"action": .72})

if __name__ == "__main__": unittest.main()
