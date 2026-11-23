#include "foothold/core.hpp"

#include <iomanip>
#include <iostream>

using namespace foothold;

namespace {
template<class Range>
void print(const Range& values) {
    for (const auto value : values) std::cout << value << ' ';
}
}

int main() {
    double top;
    Remote remote;
    Vec3 command;
    Wanted direct;
    std::cout << std::setprecision(17);
    while (std::cin >> top >> remote.lx >> remote.ly >> remote.rx >>
           command[0] >> command[1] >> command[2] >>
           direct[0] >> direct[1] >> direct[2]) {
        const auto want = remote_want(remote, top);
        const auto shaped = shape_command(want, top);
        const auto direct_shaped = shape_command(direct, top);
        slew_command(command, shaped.command);
        print(want);
        print(shaped.command);
        print(command);
        print(direct_shaped.command);
        std::cout << mark_name(shaped.mark) << ' ' << mark_name(direct_shaped.mark) << '\n';
    }
    return std::cin.eof() ? 0 : 1;
}
