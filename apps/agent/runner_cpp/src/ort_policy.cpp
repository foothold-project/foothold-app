#include "foothold/ort_policy.hpp"

#include <onnxruntime_cxx_api.h>
#include <openssl/evp.h>

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

constexpr std::array<Tensor, 9> inputs{{
    {"obs45", {1, 45}, 2}, {"hist", {1, 10, 45}, 3}, {"depth2", {1, 2, 60, 60}, 4},
    {"h_prop", {1, 128}, 2}, {"h_terr", {1, 128}, 2},
    {"depth_tick", {1}, 1, ONNX_TENSOR_ELEMENT_DATA_TYPE_BOOL},
    {"first_after_reset", {1}, 1, ONNX_TENSOR_ELEMENT_DATA_TYPE_BOOL},
    {"use_gt", {1}, 1, ONNX_TENSOR_ELEMENT_DATA_TYPE_BOOL},
    {"gt_map", {1, 32, 16}, 3},
}};
constexpr std::array<Tensor, 6> outputs{{
    {"action", {1, 12}, 2}, {"h_prop_next", {1, 128}, 2}, {"h_terr_next", {1, 128}, 2},
    {"recon_map", {1, 32, 16}, 3}, {"est_raw", {1, 51}, 2}, {"est", {1, 51}, 2},
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

std::filesystem::path verified_model(const std::filesystem::path& bundle, MapMode mode,
                                     const std::filesystem::path& debug_est) {
    const bool off = mode == MapMode::off;
    const bool debug = !debug_est.empty();
    const std::string stem = off ? "start-m15500_map_off" : "start-m15500_map_on";
    const auto path = debug ? debug_est / (stem + "_debug_est.onnx") : bundle / (stem + ".onnx");
    constexpr const char* canonical[] = {
        "be6c8b103d3b39503447ee71076ec199e5ed0688c3540ccfe449a96d6e2a9a41",
        "df91c2d772c7d054e33c74fca479e79550cfd228d7682402f7eef4a0865e279f",
    };
    constexpr const char* estimates[] = {
        "d216f35cf56a90da9521c5d56f986be0b56dd439311b8917621a88002216c611",
        "1b9718d3558a5c2d8f2383546e3ac82e56a55164b2b5aa50b1e816e64438b31a",
    };
    const auto expected = (debug ? estimates : canonical)[off ? 0 : 1];
    if (sha256(path) != expected) throw std::runtime_error("model SHA-256 differs from contract");
    return path;
}

Ort::SessionOptions session_options() {
    Ort::SessionOptions options;
    options.SetIntraOpNumThreads(2);
    options.SetInterOpNumThreads(1);
    options.SetExecutionMode(ORT_SEQUENTIAL);
    return options;
}

void verify_tensors(Ort::Session& session, bool input, std::size_t output_count) {
    Ort::AllocatorWithDefaultOptions alloc;
    const auto count = input ? session.GetInputCount() : session.GetOutputCount();
    if (count != (input ? inputs.size() : output_count))
        throw std::runtime_error("model tensor count differs from contract");
    for (std::size_t i = 0; i < count; ++i) {
        const auto& spec = input ? inputs[i] : outputs[i];
        const auto name = input ? session.GetInputNameAllocated(i, alloc)
                                : session.GetOutputNameAllocated(i, alloc);
        const auto info = input ? session.GetInputTypeInfo(i) : session.GetOutputTypeInfo(i);
        const auto tensor = info.GetTensorTypeAndShapeInfo();
        const auto shape = tensor.GetShape();
        if (std::string_view(name.get()) != spec.name || tensor.GetElementType() != spec.type ||
            shape.size() != spec.rank || !std::equal(shape.begin(), shape.end(), spec.shape.begin()))
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
    Ort::Env env{ORT_LOGGING_LEVEL_WARNING, "foothold"};
    Ort::Session session;
    Ort::MemoryInfo cpu = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    Ort::RunOptions run_options;
    Inputs in;
    Outputs out;
    std::array<Ort::Value, 9> input;
    std::array<float, 51> est_raw{}, est{};
    std::array<Ort::Value, 6> output;
    const std::size_t output_count;

    Impl(const std::filesystem::path& model, bool debug)
        : session(env, model.c_str(), session_options()),
          input{bind_tensor(cpu, inputs[0], in.obs), bind_tensor(cpu, inputs[1], in.hist),
                bind_tensor(cpu, inputs[2], in.depth2), bind_tensor(cpu, inputs[3], in.h_prop),
                bind_tensor(cpu, inputs[4], in.h_terr), bind_tensor(cpu, inputs[5], &in.depth_tick, 1),
                bind_tensor(cpu, inputs[6], &in.first_after_reset, 1),
                bind_tensor(cpu, inputs[7], &in.use_gt, 1), bind_tensor(cpu, inputs[8], in.gt_map)},
          output{bind_tensor(cpu, outputs[0], out.action), bind_tensor(cpu, outputs[1], out.h_prop),
                 bind_tensor(cpu, outputs[2], out.h_terr), bind_tensor(cpu, outputs[3], out.recon),
                 bind_tensor(cpu, outputs[4], est_raw), bind_tensor(cpu, outputs[5], est)},
          output_count(debug ? output.size() : output.size() - 2) {
        verify_tensors(session, true, output_count);
        verify_tensors(session, false, output_count);
    }

    void run() {
        static constexpr auto input_names = names(inputs);
        static constexpr auto output_names = names(outputs);
        session.Run(run_options, input_names.data(), input.data(), input.size(),
                    output_names.data(), output.data(), output_count);
        if (output_count == output.size()) out.estimate = Estimate{est_raw[16], {est[16], est[17], est[18]}};
    }
};

OrtPolicy::OrtPolicy(const std::filesystem::path& bundle, MapMode mode, const std::filesystem::path& debug_est)
    : impl_(std::make_unique<Impl>(verified_model(bundle, mode, debug_est), !debug_est.empty())) {}
OrtPolicy::~OrtPolicy() = default;

void OrtPolicy::infer(const Inputs& inputs, Outputs& outputs) {
    impl_->in = inputs;
    impl_->run();
    outputs = impl_->out;
}

MapMode parse_map_mode(std::string_view value) {
    if (value == "off") return MapMode::off;
    if (value == "reconstruction") return MapMode::reconstruction;
    if (value == "gt") return MapMode::gt;
    throw std::invalid_argument("invalid map mode");
}

}
