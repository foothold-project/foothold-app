#include "foothold/ort_policy.hpp"

#include <onnxruntime_cxx_api.h>
#include <openssl/evp.h>
#ifdef FOOTHOLD_MAPMASK
#include <nlohmann/json.hpp>
#endif

#include <algorithm>
#include <fstream>
#include <string>

namespace foothold {
namespace {
struct Tensor {
    const char* name;
    std::array<int64_t, 4> shape;
    std::size_t rank;
    ONNXTensorElementDataType type = ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT;
};

constexpr std::array<Tensor, 9> canon_inputs{{
    {"obs45", {1, 45}, 2}, {"hist", {1, 10, 45}, 3}, {"depth2", {1, 2, 60, 60}, 4},
    {"h_prop", {1, 128}, 2}, {"h_terr", {1, 128}, 2},
    {"depth_tick", {1}, 1, ONNX_TENSOR_ELEMENT_DATA_TYPE_BOOL},
    {"first_after_reset", {1}, 1, ONNX_TENSOR_ELEMENT_DATA_TYPE_BOOL},
    {"use_gt", {1}, 1, ONNX_TENSOR_ELEMENT_DATA_TYPE_BOOL},
    {"gt_map", {1, 32, 16}, 3},
}};
constexpr std::array<Tensor, 4> canon_outputs{{
    {"action", {1, 12}, 2}, {"h_prop_next", {1, 128}, 2}, {"h_terr_next", {1, 128}, 2},
    {"recon_map", {1, 32, 16}, 3},
}};

constexpr std::array<Tensor, 9> mask_inputs{{
    {"o", {1, 45}, 2}, {"hist", {1, 10, 45}, 3}, {"depth2", {1, 2, 60, 60}, 4},
    {"h_prop", {1, 128}, 2}, {"h_terr", {1, 128}, 2},
    {"tick", {1, 1}, 2}, {"first", {1, 1}, 2}, {"pose", {1, 2}, 2}, {"map_mask", {1, 1}, 2},
}};
constexpr std::array<Tensor, 5> mask_outputs{{
    {"action", {1, 12}, 2}, {"h_prop_out", {1, 128}, 2}, {"h_terr_out", {1, 128}, 2},
    {"refined_map", {1, 32, 16}, 3}, {"est", {1, 51}, 2},
}};

template<std::size_t N>
constexpr auto names(const std::array<Tensor, N>& tensors) {
    std::array<const char*, N> result{};
    for (std::size_t i = 0; i < N; ++i) result[i] = tensors[i].name;
    return result;
}

std::string sha256(const std::filesystem::path& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) throw std::runtime_error("cannot read model: " + path.string());
    std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> ctx(EVP_MD_CTX_new(), EVP_MD_CTX_free);
    if (!ctx || EVP_DigestInit_ex(ctx.get(), EVP_sha256(), nullptr) != 1)
        throw std::runtime_error("cannot initialize SHA-256");
    std::array<char, 65536> buf{};
    while (file.read(buf.data(), buf.size()) || file.gcount()) {
        if (EVP_DigestUpdate(ctx.get(), buf.data(), file.gcount()) != 1)
            throw std::runtime_error("cannot hash model");
    }
    std::array<unsigned char, 32> digest{};
    unsigned int size = 0;
    if (!file.eof() || file.bad() || EVP_DigestFinal_ex(ctx.get(), digest.data(), &size) != 1 ||
        size != digest.size()) throw std::runtime_error("cannot finish model hash");
    std::string result;
    for (const auto byte : digest) {
        constexpr char hex[] = "0123456789abcdef";
        result += hex[byte >> 4];
        result += hex[byte & 15];
    }
    return result;
}

struct Model {
    std::filesystem::path path;
    bool mapmask = false;
};

#ifdef FOOTHOLD_MAPMASK
using Json = nlohmann::json;

Json read_contract(const std::filesystem::path& path) {
    std::ifstream file(path);
    if (!file) throw std::runtime_error("cannot read ONNX contract");
    return Json::parse(file);
}

template<std::size_t N>
void verify_contract_tensors(const Json& entries, const std::array<Tensor, N>& expected,
                             bool dynamic_batch, bool inputs) {
    if (!entries.is_array() || entries.size() != N)
        throw std::runtime_error("ONNX contract tensor count mismatch");
    for (std::size_t i = 0; i < N; ++i) {
        const auto& spec = expected[i];
        const auto& entry = entries.at(i);
        const auto& shape = entry.at(dynamic_batch ? "shape" : "dims");
        const char* dtype = spec.type == ONNX_TENSOR_ELEMENT_DATA_TYPE_BOOL ? "bool" : "float32";
        if (entry.at("name") != spec.name || !shape.is_array() || shape.size() != spec.rank ||
            ((!dynamic_batch || inputs || entry.contains("dtype")) &&
             entry.at(dynamic_batch ? "dtype" : "type") != dtype))
            throw std::runtime_error(std::string("ONNX contract tensor mismatch: ") + spec.name);
        for (std::size_t axis = 0; axis < spec.rank; ++axis) {
            if (shape.at(axis) != (dynamic_batch && axis == 0 ? Json("batch") : Json(spec.shape[axis])))
                throw std::runtime_error(std::string("ONNX contract shape mismatch: ") + spec.name);
        }
    }
}
#endif

Model verified_model(const std::filesystem::path& bundle, MapMode mode) {
    const auto mask_contract = bundle / "start_onnx.json";
    if (std::filesystem::exists(mask_contract)) {
#ifdef FOOTHOLD_MAPMASK
        if (mode == MapMode::gt) throw std::invalid_argument("map-mask has no GT input");
        const auto contract = read_contract(mask_contract);
        if (contract.at("format") != "foothold-start-onnx/2" ||
            contract.at("depth_tick") != 5 || contract.at("depth_delay_ticks") != 1 ||
            contract.at("map_mask").at("on") != 0. || contract.at("map_mask").at("off") != 1.)
            throw std::runtime_error("unsupported map-mask contract");
        verify_contract_tensors(contract.at("step_inputs"), mask_inputs, true, true);
        verify_contract_tensors(contract.at("step_outputs"), mask_outputs, true, false);
        const auto path = bundle / "start_step.onnx";
        if (sha256(path) != contract.at("files").at("start_step.onnx").get<std::string>())
            throw std::runtime_error("model SHA-256 differs from contract");
        return {path, true};
#else
        throw std::invalid_argument("map-mask requires a build with FOOTHOLD_WITH_MAPMASK");
#endif
    }
    if (mode == MapMode::automatic) throw std::invalid_argument("auto mode requires a map-mask contract");
    const bool off = mode == MapMode::off;
    const auto* file = off ? "start-m15500_map_off.onnx" : "start-m15500_map_on.onnx";
    const auto* expected = off ? "be6c8b103d3b39503447ee71076ec199e5ed0688c3540ccfe449a96d6e2a9a41"
                               : "df91c2d772c7d054e33c74fca479e79550cfd228d7682402f7eef4a0865e279f";
#ifdef FOOTHOLD_MAPMASK
    if (std::filesystem::exists(bundle / "contract.json")) {
        const auto contract = read_contract(bundle / "contract.json");
        if (contract.at("format") != "start-m15500-onnx/1")
            throw std::runtime_error("unsupported canonical START contract");
        const auto& entry = contract.at("artifacts").at(off ? "map_off" : "map_on");
        if (entry.at("name") != file || entry.at("sha256") != expected)
            throw std::runtime_error("canonical model identity differs from pinned contract");
        const auto& io = contract.at("app_onnx");
        verify_contract_tensors(io.at("inputs"), canon_inputs, false, true);
        verify_contract_tensors(io.at("outputs"), canon_outputs, false, false);
    }
#endif
    const auto path = bundle / file;
    if (sha256(path) != expected) throw std::runtime_error("model SHA-256 differs from contract");
    return {path};
}

Ort::SessionOptions session_options() {
    Ort::SessionOptions options;
    options.SetIntraOpNumThreads(2);
    options.SetInterOpNumThreads(1);
    options.SetExecutionMode(ORT_SEQUENTIAL);
    return options;
}

template<std::size_t N>
void verify_tensors(Ort::Session& session, const std::array<Tensor, N>& specs, bool input,
                    bool dynamic_batch) {
    Ort::AllocatorWithDefaultOptions alloc;
    const auto count = input ? session.GetInputCount() : session.GetOutputCount();
    if (count != specs.size()) throw std::runtime_error("model tensor count differs from contract");
    for (std::size_t i = 0; i < count; ++i) {
        const auto& spec = specs[i];
        const auto name = input ? session.GetInputNameAllocated(i, alloc)
                                : session.GetOutputNameAllocated(i, alloc);
        const auto info = input ? session.GetInputTypeInfo(i) : session.GetOutputTypeInfo(i);
        const auto tensor = info.GetTensorTypeAndShapeInfo();
        const auto shape = tensor.GetShape();
        auto expected = spec.shape;
        if (dynamic_batch) expected[0] = -1;
        if (std::string_view(name.get()) != spec.name || tensor.GetElementType() != spec.type ||
            shape.size() != spec.rank || !std::equal(shape.begin(), shape.end(), expected.begin()))
            throw std::runtime_error(std::string("model tensor differs from contract: ") + spec.name);
    }
}

template<class T>
Ort::Value bind_tensor(const Ort::MemoryInfo& memory, const Tensor& spec, T* data, std::size_t size) {
    return Ort::Value::CreateTensor<T>(memory, data, size, spec.shape.data(), spec.rank);
}

template<class T, std::size_t N>
Ort::Value bind_tensor(const Ort::MemoryInfo& memory, const Tensor& spec, std::array<T, N>& data) {
    return bind_tensor(memory, spec, data.data(), data.size());
}
}

struct OrtPolicy::Impl {
    const bool mapmask;
    Ort::Env env{ORT_LOGGING_LEVEL_WARNING, "foothold"};
    Ort::Session session;
    Ort::MemoryInfo cpu = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    Ort::RunOptions run_options;
    Inputs in;
    Outputs out;
    float tick{}, first{}, mask{};
    std::array<Ort::Value, 9> input;
    std::array<Ort::Value, 5> output;

    explicit Impl(const Model& model)
        : mapmask(model.mapmask), session(env, model.path.c_str(), session_options()),
          input{bind_tensor(cpu, canon_inputs[0], in.obs), bind_tensor(cpu, canon_inputs[1], in.hist),
                bind_tensor(cpu, canon_inputs[2], in.depth2), bind_tensor(cpu, canon_inputs[3], in.h_prop),
                bind_tensor(cpu, canon_inputs[4], in.h_terr),
                mapmask ? bind_tensor(cpu, mask_inputs[5], &tick, 1)
                        : bind_tensor(cpu, canon_inputs[5], &in.depth_tick, 1),
                mapmask ? bind_tensor(cpu, mask_inputs[6], &first, 1)
                        : bind_tensor(cpu, canon_inputs[6], &in.first_after_reset, 1),
                mapmask ? bind_tensor(cpu, mask_inputs[7], in.pose)
                        : bind_tensor(cpu, canon_inputs[7], &in.use_gt, 1),
                mapmask ? bind_tensor(cpu, mask_inputs[8], &mask, 1)
                        : bind_tensor(cpu, canon_inputs[8], in.gt_map)},
          output{bind_tensor(cpu, canon_outputs[0], out.action), bind_tensor(cpu, canon_outputs[1], out.h_prop),
                 bind_tensor(cpu, canon_outputs[2], out.h_terr), bind_tensor(cpu, canon_outputs[3], out.recon),
                 mapmask ? bind_tensor(cpu, mask_outputs[4], out.est) : Ort::Value(nullptr)} {
        verify_tensors(session, mapmask ? mask_inputs : canon_inputs, true, mapmask);
        if (mapmask) verify_tensors(session, mask_outputs, false, true);
        else verify_tensors(session, canon_outputs, false, false);
    }

    void run() {
        static constexpr auto canon_input_names = names(canon_inputs);
        static constexpr auto canon_output_names = names(canon_outputs);
        static constexpr auto mask_input_names = names(mask_inputs);
        static constexpr auto mask_output_names = names(mask_outputs);
        if (mapmask) {
            tick = in.depth_tick ? 1.f : 0.f;
            first = in.first_after_reset ? 1.f : 0.f;
            mask = in.map_mask ? 1.f : 0.f;
            if (in.map_mask) in.depth2.fill(1.f);
        }
        session.Run(run_options, mapmask ? mask_input_names.data() : canon_input_names.data(),
                    input.data(), input.size(),
                    mapmask ? mask_output_names.data() : canon_output_names.data(), output.data(),
                    mapmask ? mask_output_names.size() : canon_output_names.size());
    }
};

OrtPolicy::OrtPolicy(const std::filesystem::path& bundle, MapMode mode)
    : impl_(std::make_unique<Impl>(verified_model(bundle, mode))) {}
OrtPolicy::~OrtPolicy() = default;

bool OrtPolicy::mapmask_contract() const { return impl_->mapmask; }

void OrtPolicy::infer(const Inputs& inputs, Outputs& outputs) {
    impl_->in = inputs;
    impl_->run();
    outputs = impl_->out;
}

MapMode parse_map_mode(std::string_view value) {
    if (value == "off") return MapMode::off;
    if (value == "reconstruction") return MapMode::reconstruction;
    if (value == "gt") return MapMode::gt;
    if (value == "auto") return MapMode::automatic;
    throw std::invalid_argument("invalid map mode");
}

}
