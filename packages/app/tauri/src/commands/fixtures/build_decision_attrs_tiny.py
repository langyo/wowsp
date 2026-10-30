"""Build the synthetic 4-input ONNX fixture for the attrs-capable models.

Not a trained model: a tiny graph whose purpose is to prove the Rust side
detects and feeds the `attrs` input correctly. Outputs are exact sums, so
the unit test can assert closed-form values.

  logitA = sum(entity) + 100 * attrs[0] - 100 * attrs[1]
  logitB = sum(global_feat) + mask[0] - 0.5

attrs only touches logitA: if the input is dropped or zero-filled the
assertion fails loudly.
"""
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

SLOTS = 2
ENTITY_DIM = 3
GLOBAL_DIM = 1
ATTR_DIM = 10


def main() -> None:
    entity = helper.make_tensor_value_info("entity", TensorProto.FLOAT, [1, SLOTS, ENTITY_DIM])
    global_feat = helper.make_tensor_value_info("global_feat", TensorProto.FLOAT, [1, GLOBAL_DIM])
    mask = helper.make_tensor_value_info("mask", TensorProto.FLOAT, [1, SLOTS])
    attrs = helper.make_tensor_value_info("attrs", TensorProto.FLOAT, [1, ATTR_DIM])
    logit_a = helper.make_tensor_value_info("logitA", TensorProto.FLOAT, [1])
    logit_b = helper.make_tensor_value_info("logitB", TensorProto.FLOAT, [1])

    def i64(values):
        return np.array(values, dtype=np.int64)

    init = [
        numpy_helper.from_array(
            np.array([100.0] + [0.0] * (ATTR_DIM - 1), dtype=np.float32).reshape(1, ATTR_DIM),
            "w_attr_pos",
        ),
        numpy_helper.from_array(
            np.array([0.0, -100.0] + [0.0] * (ATTR_DIM - 2), dtype=np.float32).reshape(1, ATTR_DIM),
            "w_attr_neg",
        ),
        numpy_helper.from_array(np.array([0.5], dtype=np.float32), "half_b"),
        numpy_helper.from_array(i64([1, 2]), "axes_entity"),
        numpy_helper.from_array(i64([1]), "axes_one"),
        numpy_helper.from_array(i64([0]), "slice_starts"),
        numpy_helper.from_array(i64([1]), "slice_ends"),
        numpy_helper.from_array(i64([1]), "slice_axes"),
        numpy_helper.from_array(i64([1]), "shape_one"),
    ]

    nodes = [
        helper.make_node(
            "ReduceSum", ["entity", "axes_entity"], ["entity_sum"], keepdims=1
        ),
        helper.make_node("Mul", ["attrs", "w_attr_pos"], ["attr_pos"]),
        helper.make_node("Mul", ["attrs", "w_attr_neg"], ["attr_neg"]),
        helper.make_node(
            "ReduceSum", ["attr_pos", "axes_one"], ["attr_pos_sum"], keepdims=1
        ),
        helper.make_node(
            "ReduceSum", ["attr_neg", "axes_one"], ["attr_neg_sum"], keepdims=1
        ),
        helper.make_node("Add", ["entity_sum", "attr_pos_sum"], ["a1"]),
        helper.make_node("Add", ["a1", "attr_neg_sum"], ["a2"]),
        helper.make_node("Reshape", ["a2", "shape_one"], ["logitA"]),
        helper.make_node(
            "ReduceSum", ["global_feat", "axes_one"], ["g_sum"], keepdims=1
        ),
        helper.make_node(
            "Slice",
            ["mask", "slice_starts", "slice_ends", "slice_axes"],
            ["mask0"],
        ),
        helper.make_node("Add", ["g_sum", "mask0"], ["b1"]),
        helper.make_node("Sub", ["b1", "half_b"], ["b2"]),
        helper.make_node("Reshape", ["b2", "shape_one"], ["logitB"]),
    ]

    graph = helper.make_graph(
        nodes,
        "decision_attrs_tiny",
        [entity, global_feat, mask, attrs],
        [logit_a, logit_b],
        initializer=init,
    )
    model = helper.make_model(
        graph,
        producer_name="wowsp-fixture",
        opset_imports=[helper.make_opsetid("", 17)],
    )
    model.ir_version = 8
    onnx.checker.check_model(model)

    out = Path(__file__).with_name("decision_attrs_tiny.onnx")
    out.write_bytes(model.SerializeToString())
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
